Wajhah

An AI assistant that helps citizens and residents in Saudi Arabia file a complaint with the right government entity.

The problem

When something goes wrong, most people don't know which government entity handles their complaint. They have to find the right entity, download its app, work through its category menus, and write the complaint themselves. Complaints are often rejected because they went to the wrong place or were missing a required document.

The idea

Wajhah gives users one place to start. The user describes the problem in plain language, and an AI agent does the rest:

Sign in with Nafath.
Describe the problem in Arabic or English, by text.
The agent works out the details: it identifies the responsible entity, extracts the key facts (date, merchant, amount, location), and asks for any documents that entity requires.
Review and approve: the agent drafts a formal complaint and shows it to the user. Nothing is submitted without the user's explicit confirmation.
Submit and track: the complaint is sent to the entity, and the user gets a reference number and status updates.
Scope of this project

The project shows that the routing, drafting and approval flow works end to end, with the outside systems simulated:

Government entities are replaced by mock APIs built by the team.
Five pilot entities are covered: Ministry of Investment, Ministry of Information, Ministry of Health, Ministry of Education, Ministry of Human Resources and Social Development.

Wajhah does not give legal advice and does not connect to real government systems.

Tech stack
Mobile app: React Native (Expo)
Backend: Node.js and Express
Database: MongoDB
AI: an LLM API for triage, routing and drafting
