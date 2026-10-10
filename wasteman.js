// ── Wasteman — general-purpose AI assistant for LPGP Tracker ─────────────────
// Full capabilities: company DB (read-only SQL), web search, URL fetching,
// long-term memory, and general assistant for anything else.

let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { /* dep not installed */ }

const MODEL = 'claude-sonnet-4-6';

// ── Safety guard for the query_database tool ─────────────────────────────────
function validateSql(sql) {
  const clean = sql.trim()
    .replace(/\/\*[\s\S]*?\*\//g, '')   // strip block comments
    .replace(/--[^\n]*/g, '')            // strip line comments
    .trim();
  if (!/^SELECT\b/i.test(clean))
    return { ok: false, reason: 'Only SELECT queries are allowed.' };
  if (/\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE|COPY|VACUUM|EXECUTE)\b/i.test(clean))
    return { ok: false, reason: 'Write or admin operations are not permitted.' };
  if (/portal_pin|password\b/i.test(clean))
    return { ok: false, reason: 'Access to credentials columns is not permitted.' };
  return { ok: true, sql: clean };
}

function addRowLimit(sql, cap = 150) {
  return /\bLIMIT\s+\d+/i.test(sql) ? sql : sql.trimEnd().replace(/;?\s*$/, '') + ` LIMIT ${cap}`;
}

// ── Web helpers ───────────────────────────────────────────────────────────────
async function searchWeb(query) {
  try {
    const iaUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    let ia;
    try {
      const iaRes = await fetch(iaUrl, {
        headers: { 'User-Agent': 'LPGP-Wasteman/1.0' },
        signal: controller.signal
      });
      ia = await iaRes.json();
    } finally {
      clearTimeout(timer);
    }
    const results = [];
    if (ia.Answer) results.push({ type: 'answer', text: ia.Answer });
    if (ia.AbstractText) results.push({ type: 'summary', source: ia.AbstractSource, text: ia.AbstractText, url: ia.AbstractURL });
    (ia.RelatedTopics || []).slice(0, 6).forEach(t => {
      if (t.Text) results.push({ type: 'related', text: t.Text, url: t.FirstURL });
    });
    if (!results.length) {
      return { query, note: 'No instant answer found. Use fetch_url to read a specific relevant page — e.g. a Wikipedia URL, news site, or official source.' };
    }
    return { query, results };
  } catch (e) {
    // DuckDuckGo may be blocked or slow from the server environment.
    // Return a clear error so Claude can acknowledge it and suggest alternatives.
    return { query, error: 'Web search unavailable right now (' + e.message + '). Suggest the user searches manually, or try fetch_url with a known URL instead.' };
  }
}

async function fetchUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LPGP-Wasteman/1.0)' },
      signal: controller.signal
    });
    if (!res.ok) return { url, error: `HTTP ${res.status} ${res.statusText}` };
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 10000);
    return { url, text };
  } catch (e) {
    return { url, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOL_DEFS = [
  {
    name: 'web_search',
    description: 'Search the web for current information: exchange rates, news, laws, prices, regulations, general facts, anything not in the company database or your training data. Use for real-time or external knowledge.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query' } },
      required: ['query']
    }
  },
  {
    name: 'fetch_url',
    description: 'Fetch and read the text content of any web page or URL — a Wikipedia article, a news story, a government page, an API endpoint, etc. Use after web_search to read a specific result, or when you already know the URL.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Full URL to fetch' } },
      required: ['url']
    }
  },
  {
    name: 'query_database',
    description: `Run a safe read-only SELECT query on the company's PostgreSQL database.

Available tables and key columns:
• employees — id, name, job_title, department, employment_type (payroll|self_employed), currency (GBP|AED|PHP), annual_salary, active (1=active 0=terminated), start_date, termination_date, allowance_days
• monthly_payments — id, employee_id, payment_month (1-12), payment_year, amount, currency, notes
• office_deductions — id, employee_id, amount, deduction_date, reason
• bonuses — id, employee_id, amount, bonus_date, notes
• salary_history — id, employee_id, annual_salary, effective_from
• daily_records — id, employee_id, record_date, clock_in, clock_out, is_day_off (0/0.5/1)
• day_off_requests — id, employee_id, request_date, status, reason
• manual_adjustments — id, employee_id, record_date, adjustment_minutes
• hotel_expenses — id, event_name, hotel, cost, av_amount, paid_amount, currency, status, event_year
• deals (= deal_tracker) — id, company, paid_inc_vat, deal_amount, tax_vat, status, date_invoice_issued, date_paid, invoice_number
• portfolio_events — id, name, event_date, location
• deal_events — deal_id, event_id, allocated_amount, package_label
• producer_teams — key (upper-cased group label), name (the producer group as written on events, e.g. "GIO & KARAM"; join with UPPER(TRIM(portfolio_events.producer)) = key), producer_id, co_producer_id, sales_id, delegates_id (each → employees.id, NULL if nobody or someone outside the company), producer, co_producer, sales, delegates (the person's name). The team that works a producer group's events. To find what an employee worked on, match their id in any of the *_id columns, then the group's events via portfolio_events.producer.
• wasteman_memory — key, value (your own long-term memory store)

SELECT only. No INSERT/UPDATE/DELETE. A LIMIT is added automatically if omitted.`,
    input_schema: {
      type: 'object',
      properties: { sql: { type: 'string', description: 'SELECT query to run' } },
      required: ['sql']
    }
  },
  {
    name: 'get_salary_overview',
    description: 'Get the fully-computed salary summary for all employees for a given year. Includes: net_remaining (what is genuinely still owed this year, after PAYE, day-off deductions, and office deductions), pct_paid, net_monthly, payments[], office_deductions[], bonuses[]. More accurate than raw SQL for salary questions because it applies UK PAYE and pro-rating automatically.',
    input_schema: {
      type: 'object',
      properties: { year: { type: 'integer', description: 'Year (defaults to current year)' } }
    }
  },
  {
    name: 'remember_fact',
    description: "Save a fact, rule, preference, or note to long-term memory so it's available in future conversations. Use when the user tells you something worth remembering (a business rule, an employee note, a preference, a policy, etc.). The key should be short and descriptive.",
    input_schema: {
      type: 'object',
      properties: {
        key:   { type: 'string', description: 'Short label, e.g. "fiscal_year_start" or "ali_note"' },
        value: { type: 'string', description: 'What to remember' }
      },
      required: ['key', 'value']
    }
  },
  {
    name: 'get_memories',
    description: 'Retrieve all saved long-term memories (facts, preferences, notes from past conversations). Call this when the user references something you should know but the current conversation has not established.',
    input_schema: { type: 'object', properties: {} }
  }
];

// ── System prompt ─────────────────────────────────────────────────────────────
function systemPrompt(memories) {
  const today = new Date().toISOString().slice(0, 10);
  const memBlock = memories && memories.length
    ? '\n\nStored memories from past conversations:\n' +
      memories.map(m => `  • ${m.key}: ${m.value}`).join('\n')
    : '';

  return `You are Wasteman, a highly capable AI assistant built into the LPGP Connect management system. You help the admin with anything — company questions, general knowledge, coding, writing, maths, advice, research. You are not limited to company data.

Today: ${today}.${memBlock}

## Tools you have
- web_search + fetch_url → access the live web for current info (exchange rates, news, legal rules, anything)
- query_database → read any table in the company PostgreSQL database (SELECT only)
- get_salary_overview → fully computed salary/payment summary including PAYE, deductions, net remaining
- remember_fact / get_memories → long-term memory that persists across conversations

## Behaviour
- Always use tools for live data. Never guess a figure from memory.
- For salary/payment questions, prefer get_salary_overview — it handles UK PAYE and deductions automatically, more accurate than raw SQL.
- For other company data (attendance, events, deals, hotel records), use query_database.
- For anything requiring current information (today's exchange rate, UK minimum wage, news), use web_search then fetch_url to read a specific page if needed.
- If the user tells you something worth remembering across sessions, use remember_fact and tell them you've remembered it.
- You are read-only on the company system — if asked to make a change, explain you can't yet and tell them where to do it in the app. (Write access may be added later.)

## Currency rules
GBP = £, AED = "AED ", PHP = ₱. Always display in the employee's own currency. Don't convert unless asked.

## Style — casual & friendly
- Talk like a mate, not a corporate bot. Be relaxed, warm, and a bit funny when it fits.
- Open replies casually — "Bro, here's the answer...", "Alright so...", "Yeah so...", "Gotcha —". Mix it up, don't use the same opener every time.
- Still be accurate and clear: casual tone, but figures and facts must be spot on. Lead with the answer.
- ZERO markdown formatting. No asterisks, no **bold**, no _italic_, no # headers, no bullet dashes, no backticks. Plain sentences only. If you need a list, just write "First... Second... Third..." inline, or number them like "1. ... 2. ...".
- If web search fails or is unavailable, just say so casually and give your best answer from what you know, or suggest the user Google it themselves.
- Confident and helpful — you can do a lot, so be generous with what you offer.`;
}

// ── Route registration ────────────────────────────────────────────────────────
function registerWasteman(app, { requireAuth, requireAdmin, db }) {
  app.post('/api/wasteman', requireAuth, requireAdmin, async (req, res) => {
    if (!Anthropic)
      return res.status(503).json({ error: 'Run "npm install" to add the @anthropic-ai/sdk package.' });
    if (!process.env.ANTHROPIC_API_KEY)
      return res.status(503).json({ error: 'Set the ANTHROPIC_API_KEY environment variable on the server.' });

    const history  = Array.isArray(req.body?.messages) ? req.body.messages : null;
    const question = (req.body?.question || '').toString();
    if (!history && !question.trim())
      return res.status(400).json({ error: 'Ask Wasteman a question.' });

    const messages = history
      ? history
          .filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content)
          .map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }))
      : [{ role: 'user', content: question }];

    // Load memories into system prompt context
    let memories = [];
    try { memories = await db.getMemories(); } catch { /* table may not exist yet on first boot */ }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const withTimeout = (p, ms) => Promise.race([
      p,
      new Promise((_, reject) => setTimeout(() => reject(new Error('AI response timed out — try again')), ms))
    ]);

    try {
      let reply = '';
      for (let step = 0; step < 8; step++) {
        const response = await withTimeout(client.messages.create({
          model: MODEL,
          max_tokens: 1500,
          system: [{ type: 'text', text: systemPrompt(memories), cache_control: { type: 'ephemeral' } }],
          tools: TOOL_DEFS,
          messages
        }), 80000);

        messages.push({ role: 'assistant', content: response.content });

        if (response.stop_reason !== 'tool_use') {
          reply = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
          break;
        }

        const toolResults = [];
        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;
          let result;
          try {
            const inp = block.input || {};
            switch (block.name) {
              case 'web_search':
                result = await searchWeb(inp.query || '');
                break;

              case 'fetch_url':
                result = await fetchUrl(inp.url || '');
                break;

              case 'query_database': {
                const check = validateSql(inp.sql || '');
                if (!check.ok) { result = { error: check.reason }; break; }
                const safeSql = addRowLimit(check.sql);
                const { rows } = await db.q(safeSql, []);
                result = { rows, count: rows.length };
                break;
              }

              case 'get_salary_overview':
                result = await db.getSalaryOverview(inp.year || new Date().getFullYear());
                break;

              case 'remember_fact':
                await db.saveMemory(inp.key || 'note', inp.value || '');
                memories = await db.getMemories();
                result = { saved: true, key: inp.key };
                break;

              case 'get_memories':
                memories = await db.getMemories();
                result = memories;
                break;

              default:
                result = { error: 'Unknown tool: ' + block.name };
            }
          } catch (e) {
            console.error('Wasteman tool error [' + block.name + ']:', e.message);
            result = { error: e.message };
          }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result).slice(0, 60000)
          });
        }
        messages.push({ role: 'user', content: toolResults });
      }

      if (!reply) reply = "I couldn't come up with an answer — try rephrasing the question.";
      res.json({ reply });
    } catch (e) {
      console.error('Wasteman error:', e.message);
      const msg = /api key|authentication/i.test(e.message)
        ? 'Wasteman could not authenticate with the AI service — check the ANTHROPIC_API_KEY.'
        : `Wasteman error: ${e.message}`;
      res.status(500).json({ error: msg });
    }
  });
}

module.exports = { registerWasteman };
