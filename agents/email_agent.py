import json
from strands import Agent, tool
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands.models import BedrockModel
import re, textwrap
from strands import Agent, tool
from strands_tools import use_agent
from strands_tools import memory
import logging

# -- Classification prompt kept small: single responsibility, yes/no contract
CLASSIFICATION_SYSTEM_PROMPT = """\
Role: Classify whether a user message needs knowledge-base lookup.

Contract:
- Output exactly 'yes' if the message asks about services, pricing, timelines, packages, or documented offerings.
- Otherwise output exactly 'no'.
No extra words, punctuation, or formatting.
"""

# -- Email extraction prompt: clear contract + schema, minimal constraints
EMAIL_SYSTEM_PROMPT = """\
Role: Extract a compact summary and structured fields from an email JSON.

Inputs:
A JSON payload with keys like:
- from, to, cc, subject, date
- plain_body (prefer for NLP), html_body (fallback)
- attachments: [{filename, s3_key}...]

Output (valid JSON only):
{
  "summary":        "<<=60 words>",
  "category":       "<Work|Personal|Finance|Marketing / Promotions|Social|Spam|Travel|Receipts|Other>",
  "sentiment":      "<Positive|Neutral|Negative|Mixed>",
  "is_urgent":      <true|false>,
  "key_dates":      ["<ISO-8601>", ...],
  "amounts":        ["<100 USD>", ...],
  "action_items":   ["<string>", ...],
  "entities":       ["<Acme Corp>", "<John Doe>", ...],
  "links":          ["https://...", ...],
  "attachments":    ["invoice.pdf", "photo.jpg"]
}

Guidelines:
- Prefer plain_body; if empty, strip text from html_body.
- Extract only facts present in the message. If none for a field, return [] (not null).
- Use currency symbols/codes as written.
- Treat emoji/casual tone as sentiment signals.
- Redact PII in the summary if obviously spam/phishing.

Errors:
- If body is empty/unparsable: return { "error": "EmptyMessage" } only.
Return JSON only—no commentary.
"""

# -- KB usage guidance: retrieval policy without over-controlling style
KNOWLEGE_BASE_SYSTEM_PROMPT = """\
Role: Compose answers using knowledge-base results when relevant.

Retrieve when the user asks about:
- Services/offerings, pricing/estimates/packages,
- Timelines/delivery windows,
- Company-specific capabilities or documented processes.

Do NOT retrieve for greetings, small talk, creative tasks, general explanations, translations, or hypotheticals that don’t require specific company data.

Behavior:
- If KB results are provided: synthesize clearly and answer directly.
- If no KB results: answer helpfully with what you can, and state if specific items weren’t found.
- Output should be a ready-to-send reply (plain text). Do not mention internal tools or retrieval steps.
"""

# Enables Strands debug log level
logging.getLogger("email_agent").setLevel(logging.DEBUG)

# Sets the logging format and streams logs to stderr
logging.basicConfig(
    format="%(levelname)s | %(name)s | %(message)s",
    handlers=[logging.StreamHandler()]
)
bedrock_model = BedrockModel(
    model_id="us.anthropic.claude-3-7-sonnet-20250219-v1:0",
    region_name='us-east-1',
    temperature=0.3,
    cache_tools='default',
)
app = BedrockAgentCoreApp()


@tool
def extract_summarize_email_assistant(email_str: str):
    try:
        email_agent = Agent(
            model=bedrock_model,
            system_prompt=EMAIL_SYSTEM_PROMPT,
        )
        response = email_agent(email_str)
        print(f"return {response}")
        return response
    except Exception as e:
        return f"Error in email assistant: {str(e)}"


@tool
def smart_reply_assistant_without_kb(input: str):
    smart_reply_agent = Agent(
        model=bedrock_model,
        callback_handler=None,
    )
    result = smart_reply_agent(input)
    return result


@tool
def smart_reply_assistant_with_KB(query: str):
    smart_reply_agent = Agent(
        model=bedrock_model,
        callback_handler=None,
        tools=[memory, use_agent],
    )

    knowledge_base_response = smart_reply_agent.tool.memory(
        action="retrieve",
        min_score=0.7,
        STRANDS_KNOWLEDGE_BASE_ID="TMND4ZVRG1",
        region_name="us-east-1",
        query=query,

        max_results=9
    )
    answer = smart_reply_agent.tool.use_agent(
        prompt=f"User question:\n{query}\n\nKnowledge base results:\n{knowledge_base_response}\n\nWrite a concise, helpful reply.",
        system_prompt=KNOWLEGE_BASE_SYSTEM_PROMPT,
    )
    logging.info(f"response is {answer['content'][0]['text']}")
    return answer


# -- Orchestrator prompt: Role, Contract, Tools, Decision logic, Style, Failure
ORCHESTRATOR_SYSTEM_PROMPT = """\
Role: Orchestrate email understanding and reply drafting.

Tools:
- extract_summarize_email_assistant(email_str: str)
- smart_reply_assistant_with_KB(query: str)
- smart_reply_assistant_without_kb(input: str)

Contract:
Given a raw email payload (JSON string):
1) Call extract_summarize_email_assistant with the raw string.
   - If it returns {"error": ...}, return that JSON immediately.
2) Decide reply path:
   - If the email asks about services/pricing/packages/timelines/offerings
     call smart_reply_assistant_with_KB using a short prompt formed from the
     extractor's "summary" (you may include subject if helpful).
   - Otherwise, call smart_reply_assistant_without_kb with the extractor "summary".
3) Merge the reply text into the extractor JSON as:
   "smart_reply": "<string>"
4) Output only the final merged JSON. No extra text.

Output JSON shape:
{
  "summary":        "<<=60 words>",
  "category":       "<Work|Personal|Finance|Marketing / Promotions|Social|Spam|Travel|Receipts|Other>",
  "sentiment":      "<Positive|Neutral|Negative|Mixed>",
  "is_urgent":      true|false,
  "key_dates":      ["<ISO-8601>", ...],
  "amounts":        ["<100 USD>", ...],
  "action_items":   ["<string>", ...],
  "entities":       ["<Acme Corp>", "<John Doe>", ...],
  "links":          ["https://...", ...],
  "attachments":    ["invoice.pdf", "photo.jpg"],
  "smart_reply":    "<string>"
}

Style:
- Keep replies concise, actionable, and ready to send.
- Do not mention tools or internal processes.

Failure handling:
- If the extractor errored, return its error JSON as-is.
- If reply drafting fails, return the extractor JSON with "smart_reply": "".
"""


@app.entrypoint
def invoke(payload):
    orchestrator = Agent(
        system_prompt=ORCHESTRATOR_SYSTEM_PROMPT,
        callback_handler=None,
        tools=[extract_summarize_email_assistant, smart_reply_assistant_with_KB, smart_reply_assistant_without_kb],
        model=bedrock_model,
    )

    # Pass the raw email payload as a JSON string to the orchestrator
    email_str = json.dumps(payload, ensure_ascii=False)

    # The orchestrator prompt dictates the exact tool-calling behavior.
    # We still add a small post-process to ensure it’s valid JSON.
    raw = orchestrator(email_str)
    text = raw["content"][0]["text"] if isinstance(raw, dict) else str(raw)

    # Best-effort: return parsed JSON or the raw text
    try:
        return json.loads(text)
    except Exception:
        return {"error": "OrchestratorInvalidJSON", "raw": text}


if __name__ == "__main__":
    app.run()
