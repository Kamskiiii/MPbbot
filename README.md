# Агент ВП (Discord)

Отдельный Discord-бот для сервера подразделения **ВП**.

Функции:

- панель «Добро пожаловать» с кнопкой **«Получить роль гостя»** (модалка ФИО → ник + роль сразу);
- кнопка **«Получить роль кандидата»** → заявка на вступление (модалка → приватная ветка → «Одобрить» с выбором должности из `positionRoleIds` / «Отклонить» → выдача должности + трёх ролей-разделителей профиля, роль кандидата не выдаётся, роль гостя снимается);
- **панель действий** (отдельный канал/сообщение): **«Запрос ролей»** / **«Заявка на отпуск»**;
- **«Запрос ролей»** → ephemeral-форма (должность ×1 + «Прочее» multi) → приватная ветка → ✅ выдаёт роли **без карточки бойца**;
- **«Заявка на отпуск»** → модалка дат → приватная ветка → при ✅ пост в канал уведомлений + роль «в отпуске»; по окончании — edit сообщения, снятие роли и тег одобрившего;

Конфиг в PostgreSQL (`vp_agent_settings`, очередь `vp_pending_requests`, отпуска `vp_leave_requests`), UI: **/tech/vp**.

Не зависит от основного `discord-bot` и от бота ATK.

У бота на сервере ВП нужны права: **Manage Roles**, **Manage Nicknames**, **Create Private Threads**, **Add Reactions**, **Manage Threads**, **Send Messages** / **Embed Links** в канале уведомлений об отпусках; роль бота выше выдаваемых ролей. В Developer Portal включите **Server Members Intent** (приглашение модераторов в ветки).

## Env

| Переменная | Назначение |
|------------|------------|
| `DISCORD_BOT_TOKEN` | Токен приложения Discord (агент ВП) |
| `VP_DISCORD_BOT_SECRET` | Общий с backend (`x-bot-secret`) |
| `BACKEND_PUBLIC_URL` | Публичный URL Nest API |
| `VP_MESSAGE_CONTENT_INTENT` | `true` — запросить privileged Message Content (иначе `Used disallowed intents`) |
| `DISCORD_PROXY` | HTTP/SOCKS прокси до Discord (на VPS: `http://127.0.0.1:10809` после Xray) |

Загрузка: корневой `.env` репозитория → `vp-bot/.env` (override).

**Лента сообщений на сайте:**  
1. Discord Developer Portal → приложение агента ВП → Bot → включить **Message Content Intent**.  
2. В env: `VP_MESSAGE_CONTENT_INTENT=true`, перезапустить `vdv-vp-bot`.  

Без шага 1 бот с `VP_MESSAGE_CONTENT_INTENT=true` не залогинится (`Used disallowed intents`).  
Без шага 2 бот работает (welcome/каталог/заявки), но текст сообщений в ленте будет пустым.

## Локально

```bash
cd vp-bot
cp .env.example .env
npm install
npm run dev
```

На сайте (techAdmin): заполнить guild / welcome / роль гостя; для вступления — канал заявок, роли модераторов, **Роли Должность** (`positionRoleIds`) и три **разделителя** профиля; для декоративных ролей и отпусков — соответствующие списки/каналы → **Сохранить** → **Опубликовать панель**.

Prod без `SYNC_DB`: выполнить по необходимости

- [`backend/scripts/add-vp-candidate-applications.sql`](../backend/scripts/add-vp-candidate-applications.sql)
- [`backend/scripts/add-vp-roles-and-leaves.sql`](../backend/scripts/add-vp-roles-and-leaves.sql)
- [`backend/scripts/add-vp-actions-panel-leave-role.sql`](../backend/scripts/add-vp-actions-panel-leave-role.sql)
- [`backend/scripts/add-vp-profile-category-roles.sql`](../backend/scripts/add-vp-profile-category-roles.sql)

## VPS (PM2)

```bash
cd /root/vdv/vp-bot
npm install && npm run build
cp .env.example .env   # или взять из корневого .env
pm2 start /root/vdv/vp-bot/ecosystem.config.cjs
pm2 save
```

Логи: `pm2 logs vdv-vp-bot`.  
Перезапуск: `pm2 restart vdv-vp-bot`.

## Bot API

Все с заголовком `x-bot-secret: <VP_DISCORD_BOT_SECRET>`:

- `GET /api/vp-agent/bot-config`
- `PATCH /api/vp-agent/bot-config/welcome-panel-message`
- `PATCH /api/vp-agent/bot-config/actions-panel-message`
- `PATCH /api/vp-agent/bot-config/panel-sync-ack`
- `POST /api/vp-agent/channel-catalog`
- `GET /api/vp-agent/channel-message-jobs/pending`
- `POST /api/vp-agent/channel-message-jobs/ack`
- `POST /api/vp-agent/requests` — создать заявку (`candidate_application` | `decorative_role_request` | `leave_request`)
- `GET /api/vp-agent/requests/pending`
- `PATCH /api/vp-agent/requests/:id/status` — `approved` / `rejected` (для отпуска в ответе может быть `leaveNotify`)
- `PATCH /api/vp-agent/leaves/:id/notify-message` — сохранить id сообщения об отпуске
- `GET /api/vp-agent/leave-notify-jobs/pending` — очередь edit «отпуск завершён»
- `POST /api/vp-agent/leave-notify-jobs/ack`
- `GET /api/vp-agent/form-discord-thread-jobs/pending` — очередь веток на embed Google Form
- `POST /api/vp-agent/form-discord-thread-jobs/ack`

## Google Form → Discord (Apps Script)

Ответы Google Form (уголовные дела ВП) → embed в Discord + **ветка на сообщении** (через vp-bot).  
Скрипт: [`backend/scripts/google-form-vp-discord-webhook.gs`](../backend/scripts/google-form-vp-discord-webhook.gs).

Prod без `SYNC_DB`: [`backend/scripts/add-vp-form-discord-thread-jobs.sql`](../backend/scripts/add-vp-form-discord-thread-jobs.sql)

### Как это работает

1. Apps Script шлёт embed через **Discord webhook** (`?wait=true` → id сообщения).
2. Apps Script ставит задачу в backend: `POST /api/vp-agent/form-discord-thread-jobs`.
3. **vp-bot** (~25 с) создаёт ветку: `message.startThread()`.

### Как выглядит embed

- **Заголовок:** «Вынесенное решение:»
- **Красная полоска** слева (`color: 15548997`)
- **Текст:** первый ответ формы — plain text; остальные — **жирная подпись** + значение
- **Картинка** герба внизу (`EMBED_IMAGE_URL`, опционально)
- **Ветка** на сообщении: имя `УД №{номер}` или `УД — {ФИО}`

### Шаг 1 — Backend и vp-bot

1. В `.env`: `VP_GOOGLE_FORM_SECRET` (= `VDV_FORM_SECRET` в Apps Script).
2. На **`/tech/vp` → Google Form**: role id следователей.
3. **Backend** каждый день **00:05 MSK** ставит sync-флаг; **vp-bot** (~25 с) обновляет кэш из Discord. Кнопка «Обновить следователей» — то же вручную.
4. **Apps Script** `refreshInvestigatorChoices` (триггер 00:00–01:00) подтягивает кэш в Google Form.
4. Prod SQL: `add-vp-google-form-settings.sql`, `add-vp-form-discord-thread-jobs.sql`.
5. У vp-bot: **Server Members Intent**, **Create Public Threads**.

### Google Form

- **Удалите** ручной вопрос «Номер уголовного приговора» — номер выдаёт backend автоматически.
- Вопрос следователя — **«Выпадающий список»** с заголовком **точно** как `INVESTIGATOR_QUESTION_TITLE` в скрипте.
- Все вопросы в embed идут с **жирной подписью** (заголовок вопроса).

### Apps Script — доп. функции

| Функция | Назначение |
|---------|------------|
| `refreshInvestigatorChoices()` | Подтянуть ФИО/ники с Discord в список формы |
| `allocateUdNumber()` | через API (вызывается автоматически при submit) |

Триггер по времени: `refreshInvestigatorChoices` → раз в день.

### Шаг 2 — Discord webhook

1. Канал → «Интеграции» → «Вебхуки» → «Новый вебхук»
2. URL → `DISCORD_WEBHOOK_URL` в скрипте

### Шаг 3 — Константы в Apps Script

| Константа | Назначение |
|-----------|------------|
| `DISCORD_WEBHOOK_URL` | Incoming Webhook |
| `EMBED_IMAGE_URL` | HTTPS URL картинки (или пусто) |
| `VDV_BACKEND_URL` | Публичный URL сайта, напр. `https://vdv-red.ru` |
| `VDV_FORM_SECRET` | = `VP_GOOGLE_FORM_SECRET` |
| `CREATE_THREAD` | `true` — создавать ветку (нужен vp-bot) |

### Шаг 4 — Порядок вопросов в Google Form

**Первый вопрос** — тип решения (`Уголовный приговор`): plain text в embed.

**Вопрос с «номер» в заголовке** — имя ветки `УД №…`. Иначе — первое «ФИО» → `УД — …`.

### Шаг 5 — Apps Script и триггер

1. Google Form → «Расширения» → «Apps Script» → вставить `.gs`
2. Заполнить константы
3. **`sendTestEmbed()`** (▶) → embed + через ~25 с ветка «УД №598»
4. Триггер: `onFormSubmit` → «При отправке формы»
5. Разрешить `UrlFetchApp` при первом запуске

**Не запускайте `onFormSubmit` вручную.**

### Troubleshooting

| Проблема | Решение |
|----------|---------|
| Embed есть, ветки нет | `VDV_FORM_SECRET` / `VP_GOOGLE_FORM_SECRET`; vp-bot запущен; права Create Public Threads |
| `401` queueThreadJob | Секрет не совпадает |
| `400` embed | `EMBED_IMAGE_URL` — полный URL или пусто |
| `onFormSubmit: нет e.response` | Запускали вручную — используйте `sendTestEmbed` |
