# Wajhah
 
An AI assistant that helps citizens and residents in Saudi Arabia file a complaint with the right government entity.
 
## The problem
 
When something goes wrong, most people don't know which government entity handles their complaint. They have to find the right entity, download its app, work through its category menus, and write the complaint themselves. Complaints are often rejected because they went to the wrong place or were missing a required document.
 
## The idea
 
Wajhah gives users one place to start. The user describes the problem in plain language and signs in with Nafath, and an AI agent does the rest:
 
1. **Describe the problem** in Arabic or English, by text.
2. **The agent works out the details**: it identifies the responsible entity, extracts the key facts (date, merchant, amount, location), and asks for any documents that entity requires.
3. **Review and approve**: the agent drafts a formal complaint and shows it to the user. Nothing is submitted without the user's explicit confirmation.
4. **Submit and track**: the complaint is sent to the entity by the user to review the formal complaint.

## Scope of this project
 
This is a university project and a proof of concept. It shows that the routing, drafting and approval flow works end to end, with the outside systems simulated:
 
- Five pilot entities are covered: Ministry of Education, Ministry of Investment, Ministry of Health, Ministry of Information, Ministry of Human Resources and Social Development.
Wajhah does not give legal advice and does not connect to real government systems.
 
## Tech stack
 
- **Web app:** React Native (Expo)
- **Backend:** FastAPI
- **Database:** PostgreSQL
- **AI:** an LLM API for triage, routing and drafting (provider to be decided)

## Team
- Mohammed Alarifi
- Rayan Aloraydi
- Raed Alokaili
- Khaled Alromaizan
 
King Saud University, Department of Software Engineering — SWE 444.
 
