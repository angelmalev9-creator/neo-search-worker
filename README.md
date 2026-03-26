# NEO Search Worker

Real-time search worker за НЕО. Когато Gemini не намери информация в контекста,
извиква този worker → той търси в crawlнатите данни в Supabase → връща excerpts.

## Архитектура

```
Клиент
  │
  ▼
Gemini (voice/chat)
  │  ← не намери информация в контекста
  │  → function_call: search_site_content({ query })
  │
  ▼
Frontend/Widget
  │  → POST /search { session_id, query }
  │
  ▼
NEO Search Worker (този сървър)
  │
  ├─ 1. Supabase: demo_sessions → structured_data.pages[]
  ├─ 2. Keyword search в crawlнатото съдържание
  └─ 3. Fallback: live fetch на сайта ако няма локални данни
  │
  ▼
{ results: [{ url, title, excerpts[], score }], elapsed_ms }
  │
  ▼
Frontend изпраща като functionResponse обратно към Gemini
  │
  ▼
Gemini отговаря с реалната информация
```

## Deploy на Portainer (Contabo VPS)

### 1. Build image на сървъра

```bash
# На VPS-а или локално с push към registry
git clone <repo> neo-search-worker
cd neo-search-worker
docker build -t neo-search-worker:latest .
```

### 2. Portainer → Stacks → Add Stack

Paste съдържанието на `docker-compose.yml` и добави environment variables:

| Variable | Стойност |
|---|---|
| `WORKER_SECRET` | Силна random string (минимум 32 chars) |
| `SUPABASE_URL` | `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key от Supabase |

### 3. Тест

```bash
curl https://your-vps-ip:3210/health
# → {"status":"ok"}

curl -X POST https://your-vps-ip:3210/search \
  -H "Authorization: Bearer YOUR_WORKER_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"session_id":"<session_id>","query":"пътечка килим цена"}'
```

### 4. Nginx reverse proxy (препоръчително)

```nginx
server {
    listen 443 ssl;
    server_name search.yourdomain.com;

    location / {
        proxy_pass http://localhost:3210;
        proxy_set_header Host $host;
    }
}
```

### 5. Добави env vars в Supabase Edge Function (geminisession)

```
SEARCH_WORKER_URL = https://search.yourdomain.com
SEARCH_WORKER_SECRET = <same as WORKER_SECRET above>
```

## Environment Variables

| Variable | Описание | Задължителен |
|---|---|---|
| `PORT` | HTTP port (default: 3210) | не |
| `WORKER_SECRET` | Bearer token за auth | да |
| `SUPABASE_URL` | Supabase project URL | да |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key | да |

## API

### POST /search

```json
// Request
{
  "session_id": "uuid-на-сесията",
  "query": "пътечка килим кафява цена",
  "site_url": "https://praktiker.bg"  // optional fallback
}

// Response
{
  "results": [
    {
      "url": "https://praktiker.bg/bg/kilimi",
      "title": "Килими - Практикер",
      "pageType": "general",
      "score": 7,
      "excerpts": [
        "Пътечки 50x80, 50x100, 50x150 см от 12.99 лв."
      ]
    }
  ],
  "keywords": ["пътечка", "килим", "кафява", "цена"],
  "elapsed_ms": 45
}
```

### GET /health

```json
{ "status": "ok", "ts": 1234567890 }
```
