# Email-уведомления о непрочитанных сообщениях

Этот модуль выполняет два процесса:

1. Клиент раз в минуту обновляет `profiles.last_seen_at`, чтобы сервер знал, что пользователь онлайн.
2. Edge Function `email-notifier` раз в X минут проверяет базу и отправляет письма тем, у кого:
   - включена опция `notify_email_messages` (страница "Настройки → Уведомления"),
   - накопились непрочитанные сообщения (`unread_message_counts`),
   - `last_seen_at` старше заданного порога (по умолчанию 60 минут),
   - и ещё не отправлено письмо для текущей пачки (`unread_notified_at` < `oldest_unread_at`).

## 1. SQL-миграции

```sql
alter table public.profiles
  add column if not exists unread_notified_at timestamptz;
```

Эта колонка хранит момент последнего письма, чтобы не дублировать уведомления.

## 2. Переменные окружения Edge Function

В Supabase (Project Settings → Functions → Environment Variables) задайте:

| Ключ | Значение |
| -- | -- |
| `RESEND_API_KEY` | API-ключ сервиса Resend (или совместимого SMTP API). |
| `NOTIFY_FROM_EMAIL` | Отправитель, напр. `Synastry <notify@synastry.app>`. |
| `APP_WEB_URL` | Ссылка на приложение/маршрут (`https://synastry.app`). |
| `NOTIFY_OFFLINE_MINUTES` | (опционально) Порог офлайна, по умолчанию 60. |

`SUPABASE_URL` и `SUPABASE_SERVICE_ROLE_KEY` Supabase подставит автоматически при деплое через CLI.

## 3. Деплой функции

```bash
cd supabase
supabase functions deploy email-notifier --no-verify-jwt
```

Локальная проверка:

```bash
supabase functions serve --no-verify-jwt email-notifier
```

и затем отправить запрос:

```bash
curl -i -X POST http://localhost:54321/functions/v1/email-notifier
```

## 4. Планировщик (cron)

В Supabase Dashboard → Database → Scheduled Triggers создайте новый trigger с запросом:

```sql
select
  net.http_post(
    url:='https://<PROJECT-REF>.functions.supabase.co/email-notifier',
    headers:='{ "Content-Type": "application/json" }',
    body:='{}'
  );
```

График `*/10 * * * *` (каждые 10 минут) подходит по умолчанию. Не забудьте включить `Enable`.

## 5. Как это работает

- Компонент `LastSeenHeartbeat` (см. `src/components/LastSeenHeartbeat.tsx`) отправляет RPC `touch_last_seen` сразу после входа пользователя и далее раз в минуту, а также по возвращению вкладки в фокус.
- Edge Function `email-notifier` (файл `supabase/functions/email-notifier/index.ts`) получает перечень кандидатов из представления `unread_message_counts`, ходит в `auth.admin.getUserById` за email и вызывает Resend API.
- После успешной рассылки колонка `profiles.unread_notified_at` обновляется, чтобы не рассылать повторно до появления новых непрочитанных сообщений.

При необходимости можно уменьшить частоту heartbeat/cron или изменить шаблон письма в функции.
