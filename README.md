# PayPilot AI



**AI-powered proposal creation, client risk review, and PayPal payment testing.**



PayPilot AI helps freelancers and small service businesses turn project briefs into structured proposals, identify unclear requirements and potential client risks, and test payment flows through PayPal Sandbox.



## Features



- **AI brief analysis:** Extract project requirements and structure information from a client brief.

- **Proposal generation:** Generate proposals with deliverables, exclusions, assumptions, milestones, and payment schedules.

- **Proposal review:** Identify missing information, unsupported assumptions, unclear requirements, and potential risks.

- **Client risk review:** Review proposal and client-related information, with findings that can be examined and addressed.

- **PayPal Sandbox integration:** Create and capture test payments using PayPal Sandbox.

- **Payment persistence:** Store payment order records in SQLite, including status information across backend restarts.

- **AI provider selection:** Use Google Gemini or a locally running Ollama model.



## Technology Stack



| Layer | Technology |

|---|---|

| Frontend | React, TypeScript, Vite |

| Backend | Node.js, Express, TypeScript |

| AI | Google Gemini API, Ollama |

| Database | SQLite, better-sqlite3 |

| Payments | PayPal Sandbox REST API |

| Testing | Node.js test runner, TypeScript |

| CI/CD | Jenkins |



## Architecture



```text

                 React Frontend

                       |

                       | REST API

                       v

                Express Backend

                       |

          +------------+------------+

          |            |            |

          v            v            v

       Gemini       Ollama       PayPal

       AI API       Local LLM    Sandbox

          |

          v

     AI Analysis,

     Proposal Generation

     and Risk Review



                Express Backend

                       |

                       v

                 SQLite Database

                 Payment Records

```



## Prerequisites



- Node.js 24 or compatible supported version

- npm

- Google Gemini API key for Gemini mode

- PayPal Sandbox application credentials

- Ollama and a compatible local model if using Ollama mode



## Getting Started



Clone the repository:



```bash

git clone https://github.com/namanshahnemi-rgb/paypilot-ai.git

cd paypilot-ai

```



### 1. Configure the backend



```bash

cd server

npm ci

```



Create your local environment file:



**Windows PowerShell:**



```powershell

Copy-Item .env.example .env

```



Configure the following values in `server/.env`:



```env

PORT=4000



AI_PROVIDER=gemini

GEMINI_API_KEY=your_gemini_api_key

GEMINI_MODEL=gemini-2.5-flash



PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com

PAYPAL_CLIENT_ID=your_paypal_sandbox_client_id

PAYPAL_CLIENT_SECRET=your_paypal_sandbox_client_secret



CLIENT_ORIGINS=http://localhost:5173,http://localhost:5174

PAYMENT_DB_PATH=

```



Never commit your actual `.env` file or credentials.



### 2. Start the backend



From the `server` directory:



```bash

npm run dev

```



The backend runs at:



```text

http://localhost:4000

```



### 3. Configure and start the frontend



Open another terminal:



```bash

cd client

npm ci

npm run dev

```



The frontend runs at:



```text

http://localhost:5173

```



For a separately hosted backend, configure `VITE_API_URL` in the frontend build environment with the backend's public API URL.



## AI Configuration



PayPilot AI supports two AI providers.



**Google Gemini**



Set:



```env

AI_PROVIDER=gemini

GEMINI_API_KEY=your_gemini_api_key

GEMINI_MODEL=gemini-2.5-flash

```



**Ollama**



Set:



```env

AI_PROVIDER=ollama

```



Make sure Ollama is running locally and the configured model is available.



Use synthetic demo information when testing external AI services. Do not submit real customer information, payment details, or confidential documents to an AI provider without appropriate authorization and privacy safeguards.



## PayPal Sandbox



PayPilot AI integrates with the PayPal Sandbox environment.



Configure a Sandbox application and add its client ID and secret to `server/.env`.



The current payment demonstration uses a fixed test amount of **$5.00 USD**. It is a gateway integration test, not an actual proposal invoice or client payment.



Use PayPal Sandbox buyer and business accounts for testing. No real-money payment is intended.



## Database



Payment order records are stored in SQLite.



The default database location is:



```text

server/data/paypilot.db

```



You can override the location with `PAYMENT_DB_PATH`.



Keep the database on persistent storage when deploying the backend. The local database and its WAL files are excluded from Git.



## Running Tests



Backend tests:



```bash

cd server

npm test

```



Backend production build:



```bash

npm run build

```



Frontend tests:



```bash

cd client

npm test

```



Frontend lint:



```bash

npm run lint

```



Frontend production build:



```bash

npm run build

```



## Continuous Integration



The repository includes a Jenkins pipeline in `Jenkinsfile`.



The pipeline checks the backend and frontend through automated tests and production builds.



## Security Notes



- Never commit `.env` files, API keys, PayPal credentials, or database files.

- Use PayPal Sandbox for demonstrations.

- Do not use real customer or confidential business data in synthetic AI demonstrations.

- Configure allowed frontend origins before public deployment.

- Use persistent storage for the SQLite database.

- Keep backend credentials on the server. Never expose them through frontend environment variables.



## Project Status



PayPilot AI is an active hackathon project. The local AI workflows, proposal generation and review, PayPal Sandbox checkout, SQLite payment persistence, and automated CI pipeline have been tested.



Public deployment and production payment processing are separate from the Sandbox demonstration.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
