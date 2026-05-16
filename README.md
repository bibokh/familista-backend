# Familista Backend — Football Intelligence Platform

> Production-ready Node.js + PostgreSQL backend for the Familista SaaS platform.

## Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20 + TypeScript |
| Framework | Express.js |
| ORM | Prisma |
| Database | PostgreSQL |
| Auth | JWT + Refresh tokens + bcrypt |
| AI | Anthropic Claude API |
| Payments | Stripe Subscriptions |
| Real-time | WebSocket (GPS live tracking) |
| Logging | Winston |

---

## Quick Start (Local)

### 1. Clone & install
```bash
git clone https://github.com/YOUR_ORG/familista-backend
cd familista-backend
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Fill in your values (see below)
```

### 3. Setup database
```bash
# Run migrations
npx prisma migrate dev --name init

# Generate Prisma client
npx prisma generate

# Seed demo data
npm run db:seed
```

### 4. Start development server
```bash
npm run dev
# API: http://localhost:4000/api/v1
# Docs: http://localhost:4000/api/v1/health
```

---

## Environment Variables

```env
# Required
DATABASE_URL="postgresql://user:pass@host:5432/familista"
JWT_SECRET="min-32-char-secret"
JWT_REFRESH_SECRET="min-32-char-refresh-secret"
ANTHROPIC_API_KEY="sk-ant-..."
STRIPE_SECRET_KEY="sk_test_..."
STRIPE_WEBHOOK_SECRET="whsec_..."
STRIPE_PRICE_BASIC="price_..."
STRIPE_PRICE_PRO="price_..."
STRIPE_PRICE_ACADEMY="price_..."
FRONTEND_URL="https://your-frontend.vercel.app"
```

---

## API Reference

All endpoints are prefixed with `/api/v1`.

### Auth
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/auth/register` | No | Register user |
| POST | `/auth/login` | No | Login |
| POST | `/auth/refresh` | No | Refresh tokens |
| POST | `/auth/logout` | No | Logout |
| GET  | `/auth/me` | ✅ | Get profile |
| PUT  | `/auth/change-password` | ✅ | Change password |

### Players
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/players` | ✅ | List players |
| POST | `/players` | ✅ | Create player |
| GET | `/players/:id` | ✅ | Get player |
| PUT | `/players/:id` | ✅ | Update player |
| DELETE | `/players/:id` | ✅ | Delete player |
| POST | `/players/:id/gps` | ✅ | Add GPS data |
| GET | `/players/:id/stats` | ✅ | Season stats |
| POST | `/players/:id/ai-analysis` | ✅ | AI analysis |

### Matches
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/matches` | List matches |
| POST | `/matches` | Create match |
| GET | `/matches/:id` | Get match |
| PUT | `/matches/:id` | Update match |
| DELETE | `/matches/:id` | Delete match |
| GET | `/matches/results` | Recent results |

### AI
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/ai/analyze` | General analysis |
| POST | `/ai/analyze-player/:id` | Player analysis |
| GET | `/ai/history` | Insight history |

### Billing
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/billing/plans` | Available plans |
| GET | `/billing/subscription` | Current subscription |
| POST | `/billing/checkout` | Create Stripe checkout |
| POST | `/billing/portal` | Billing portal |
| POST | `/billing/webhook` | Stripe webhooks |

---

## Deployment

### Railway (Backend + DB)

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login and deploy
railway login
railway init
railway add postgresql
railway up

# Set environment variables in Railway dashboard
```

### Render

1. New Web Service → Connect GitHub repo
2. Build: `npm install && npm run build && npx prisma generate && npx prisma migrate deploy`
3. Start: `npm start`
4. Add PostgreSQL addon
5. Set all env variables

### Supabase (Database)

1. Create project at supabase.com
2. Copy Connection String (Pooler — Transaction mode)
3. Set as `DATABASE_URL` in your deployment

### Neon (Alternative DB)

1. Create project at neon.tech
2. Copy connection string
3. Set as `DATABASE_URL`

---

## WebSocket (Live GPS)

Connect to: `ws://your-api.com/ws/live?clubId=YOUR_CLUB_ID`

Receives: `GPS_UPDATE` events every second with all player positions.

---

## Demo Credentials

| Role | Email | Password |
|------|-------|----------|
| Club Admin | khatab@familista.io | Familista2024! |
| Head Coach | coach@familista.io | Coach2024! |

---

## Stripe Setup

1. Create products in Stripe Dashboard (or use Stripe CLI)
2. Copy price IDs to `.env`
3. Set up webhook: `stripe listen --forward-to localhost:4000/api/v1/billing/webhook`

---

## Architecture

```
src/
├── config/          # App config + DB connection
├── controllers/     # Route handlers (thin layer)
├── services/        # Business logic
├── middleware/       # Auth, validation, error handling
├── routes/          # Express routers
├── utils/           # Logger, errors, response helpers
└── types/           # TypeScript declarations
prisma/
├── schema.prisma    # Full DB schema
└── seed.ts          # Demo data
```
