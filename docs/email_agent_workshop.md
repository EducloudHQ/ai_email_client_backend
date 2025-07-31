# Workshop: Building an AI Email Intelligence Agent with LangChain

Welcome to the workshop! Today, you'll learn how to build an AI-driven Email Intelligence Agent using LangChain. This agent will parse emails, categorize them, analyze sentiment, extract important information, and flag urgent messages.

## Objectives
By the end of this workshop, you'll be able to:

- Parse emails into structured JSON.
- Generate succinct summaries of emails.
- Classify emails into meaningful categories.
- Perform sentiment analysis.
- Extract key information from emails.
- Identify and flag urgent emails.
- Store processed information in DynamoDB.

---

## Prerequisites
Ensure you have:
- Python installed (3.9+ recommended).
- Access to AWS DynamoDB.
- LangChain and OpenAI libraries installed (`pip install langchain openai boto3`).
- Familiarity with Python and JSON data handling.

---

## Step 1: Set Up the Environment

Create a new virtual environment and install dependencies:

```bash
python -m venv email-agent-env
source email-agent-env/bin/activate
pip install langchain openai boto3
```

---

## Step 2: Define the System Prompt

The system prompt guides the AI's behavior. Here's our prompt:

```python
EMAIL_SYSTEM_PROMPT = """
You are an AI Email Intelligence Assistant capable of:
1. Parsing emails from JSON.
2. Summarizing content succinctly.
3. Categorizing emails (Work, Personal, Finance, Marketing/Promotions, Social, Spam, Travel, Receipts, Other).
4. Analyzing sentiment (Positive, Neutral, Negative, Mixed).
5. Extracting key information (dates, amounts, action items, entities, links, attachments).
6. Flagging urgent messages.
7. Outputting structured JSON for DynamoDB.
"""
```

---

## Step 3: Implement Email Parsing and Processing

Use LangChain to create a structured agent:

```python
from langchain import OpenAI

llm = OpenAI(api_key='YOUR_OPENAI_API_KEY')

# Example email payload (simplified)
email_payload = {
    "from": "John Doe <john@example.com>",
    "to": "you@example.com",
    "subject": "Meeting Reminder",
    "date": "Tue, 25 Jul 2025 15:30:00 +0100",
    "plain_body": "Reminder: Project meeting tomorrow at 10 AM. Please review the budget. 🙂",
    "attachments": [{"filename": "budget.xlsx", "s3_key": "path/to/budget.xlsx"}]
}

response = llm.invoke(EMAIL_SYSTEM_PROMPT + str(email_payload))
print(response)
```

---

## Step 4: Store Output in DynamoDB

Store your JSON output into DynamoDB:

```python
import boto3
import json

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table('your-dynamodb-table')

output_json = json.loads(response)
table.put_item(Item=output_json)
```

---

## Workshop Tasks
Now it's your turn!

- **Task 1:** Process at least 3 sample emails using your agent.
- **Task 2:** Validate the agent’s categorization accuracy.
- **Task 3:** Improve the agent prompt based on your testing results.
- **Task 4:** Implement error handling to address empty or unparsable emails.
- **Task 5:** Set up automated unit tests for your email agent.

---

## Best Practices

- Always prioritize clear and concise system prompts.
- Regularly test your prompts with varied email samples.
- Validate extracted information against known correct data.

---

## Resources
- [LangChain Documentation](https://python.langchain.com/)
- [OpenAI API Documentation](https://platform.openai.com/docs/)
- [AWS DynamoDB Guide](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/)

Enjoy the workshop and happy coding!
