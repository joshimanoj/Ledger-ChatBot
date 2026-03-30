# Ledger-ChatBot

AI-powered accounting assistant with a conversational interface. Manage ledger entries, track transactions, and generate professional invoices through natural language chat.

## Features

- **Chat-Based Accounting**: Add, query, and manage ledger entries through natural conversation
- **Invoice Generation**: Auto-generate professional PDF invoices using ReportLab
- **Transaction History**: SQLite-backed persistent transaction storage
- **Modern Web UI**: React frontend with real-time chat interface

## Tech Stack

- **Backend**: Python, Flask, SQLite
- **Frontend**: React, Vite
- **AI**: OpenAI API
- **PDF Generation**: ReportLab

## Setup

1. **Backend**: `cd server && pip install -r requirements.txt && python app.py`
2. **Frontend**: `cd frontend && npm install && npm run dev`
3. Set `OPENAI_API_KEY` environment variable
