# מדריך ה-API

Base URL: `https://<domain>/zmanim/api/v1`. כל הבקשות והתגובות ב-JSON (UTF-8). אימות: `Authorization: Bearer <token>` (חוץ מ-endpoints ציבוריים).

## מבנה תגובה

הצלחה:
```json
{ "success": true, "data": { }, "meta": { "limit": 500, "offset": 0, "count": 12 } }
```
שגיאה:
```json
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "הנתונים שנשלחו אינם תקינים",
  "details": [ { "field": "time_value", "message": "פורמט שעה נדרש: HH:MM" } ], "request_id": "..." } }
```

| סטטוס | משמעות | קודים נפוצים |
|---|---|---|
| 400 | קלט לא תקין | `VALIDATION_ERROR`, `INVALID_JSON`, `BAD_REQUEST` |
| 401 | לא מחובר / סשן פג | `UNAUTHORIZED`, `SESSION_EXPIRED`, `INVALID_CREDENTIALS` |
| 403 | אין הרשאה | `MISSING_PERMISSION`, `SYNAGOGUE_ACCESS_DENIED`, `CANNOT_MANAGE_USER`, `CANNOT_ASSIGN`, `CANNOT_MODIFY_SELF`, `ACCOUNT_DISABLED` |
| 404 | לא נמצא | `NOT_FOUND` |
| 405 | שיטה לא נתמכת | `METHOD_NOT_ALLOWED` |
| 409 | התנגשות | `IN_USE`, `HAS_DEPENDENTS`, `DUPLICATE_IDENTIFIER`, `DEFAULT_REQUIRED`, `LAST_SUPER_ADMIN` |
| 429 | יותר מדי ניסיונות | `TOO_MANY_REQUESTS` (+ כותרת `Retry-After`) |
| 500 | שגיאת שרת | `INTERNAL_ERROR` (שמרו את `request_id`) |

כללי עדכון: `PATCH` מקבל רק את השדות שמשתנים. `DELETE` ללא גוף. כל תגובה כוללת `X-Request-Id`.

## ציבורי (ללא טוקן)

| Method | נתיב | הערות |
|---|---|---|
| GET | `/health` | בדיקת חיות + DB |
| GET | `/public/minyanim` | סינון: `synagogue_id`, `area_id`, `prayer_type_id`, `season_id`; עימוד: `limit` (עד 1000), `offset`. Cache של דקה |
| GET | `/public/synagogues` | סינון: `area_id` |

## אימות

| Method | נתיב | גוף / הערות |
|---|---|---|
| POST | `/auth/login` | `{ "identifier": "email או טלפון", "password": "..." }` ← `{ token, expires_at, user }` |
| GET | `/auth/me` | פרופיל, הרשאות והיקף |
| POST | `/auth/logout` | מנתק את המכשיר הנוכחי |
| POST | `/auth/logout-all` | מנתק את כל המכשירים |
| POST | `/auth/change-password` | `{ current_password, new_password }` (מינימום 8 תווים); מנתק מכשירים אחרים |

## נתונים

הרשאה נדרשת רק לשינוי. קריאה מוגבלת אוטומטית להיקף המשתמש. חריגה מההיקף ← 403.

| Method | נתיב | הרשאה | הערות |
|---|---|---|---|
| GET | `/meta` | התחברות | סוגי תפילה, סוגי זמן, עונות, אזורים בקריאה אחת |
| GET | `/synagogues` | — | סינון `area_id` |
| GET | `/synagogues/:id` | — | |
| POST | `/synagogues` | `synagogues:create` | `{ name, area_id?, address? }`. יוצר עם היקף מוגבל מקבל אליו גישה אוטומטית |
| PATCH | `/synagogues/:id` | `synagogues:update` | |
| DELETE | `/synagogues/:id` | `synagogues:delete` | עם תוכן: 409 עד `?cascade=true` |
| GET | `/locations` | — | סינון `synagogue_id` |
| GET | `/locations/:id` | — | |
| POST | `/locations` | `locations:create` | `{ synagogue_id, name }` |
| PATCH | `/locations/:id` | `locations:update` | שם בלבד (בית הכנסת קבוע) |
| DELETE | `/locations/:id` | `locations:delete` | מניינים נשארים בלי מיקום |
| GET | `/minyanim` | — | סינון: `synagogue_id`, `location_id`, `prayer_type_id`, `season_id`; עימוד |
| GET | `/minyanim/:id` | — | |
| POST | `/minyanim` | `minyanim:create` | ראו למטה |
| PATCH | `/minyanim/:id` | `minyanim:update` | העברה לבית כנסת אחר דורשת גישה לשניהם |
| DELETE | `/minyanim/:id` | `minyanim:delete` | |

**יצירת מניין:**
```json
{ "synagogue_id": 1, "location_id": 3, "prayer_type_id": 1, "time_type_id": 1,
  "time_value": "07:30", "notes": "", "season_id": 2 }
```
`season_id` אופציונלי (ברירת מחדל: העונה המסומנת כברירת מחדל). נבדק בשרת: הפניות קיימות; המיקום שייך לבית הכנסת; שעה `HH:MM` בטווח המותר לסוג התפילה; זמן יחסי הוא מספר דקות שלם (±720); סוג הזמן מתאים לתפילה.

## הגדרות בסיס

`/areas`, `/prayer-types`, `/time-types`, `/seasons`. כולם: `GET /x` (כל משתמש), `POST /x`, `PATCH /x/:id`, `DELETE /x/:id` (דורשים `settings:manage`).

| משאב | שדות |
|---|---|
| areas | `name` |
| prayer-types | `name`, `allow_update_from`, `allow_update_to` (`HH:MM` או null) |
| time-types | `name`, `is_relative` (bool), `allowed_prayer_ids` (מערך; ריק = כל התפילות) |
| seasons | `name`, `is_default` (bool) |

עונת ברירת מחדל אחת בלבד (ההחלפה אטומית); אי אפשר למחוק אותה. ערך שבשימוש לא נמחק (409 עם ספירה).

## משתמשים

| Method | נתיב | הרשאה |
|---|---|---|
| GET | `/users` | `users:read` (רואים רק משתמשים שאפשר לנהל, ואת עצמך) |
| GET | `/users/:id` | `users:read` |
| POST | `/users` | `users:create` |
| PATCH | `/users/:id` | `users:update` |
| DELETE | `/users/:id` | `users:delete` |

```json
{ "full_name": "ישראל ישראלי", "email": "a@b.com", "phone": "0501234567", "password": "********",
  "role_id": 1, "all_synagogues": false, "synagogue_ids": [1, 4], "is_active": true }
```
נדרש אימייל או טלפון. אימייל מנורמל לאותיות קטנות, טלפון בלי מקפים ורווחים; ייחודיים. סיסמה חדשה או השבתה מנתקות את המשתמש מכל המכשירים. `is_super_admin` נקבע רק על ידי מנהל ראשי. חוקי ההקצאה: ראו README.

## תפקידים

| Method | נתיב | הרשאה |
|---|---|---|
| GET | `/permissions` | התחברות. קטלוג הרשאות עם קבוצה ותווית, לבניית תיבות סימון |
| GET | `/roles`, `/roles/:id` | `roles:manage` או הרשאת משתמשים. כולל `assignable` (האם *אתה* יכול להקצות) ו-`user_count` |
| POST | `/roles` | `roles:manage` |
| PATCH | `/roles/:id` | `roles:manage` (תפקידי מערכת: מנהל ראשי בלבד, ללא שינוי שם) |
| DELETE | `/roles/:id` | `roles:manage` (409 אם יש משתמשים; תפקידי מערכת מוגנים) |

```json
{ "name": "מנהל אזור צפון", "description": "...", "permissions": ["minyanim:create", "minyanim:update", "users:read"] }
```

## זרימה טיפוסית

1. מנהל ראשי נכנס: `POST /auth/login`.
2. יוצר תפקיד: `POST /roles` (בוחר הרשאות מ-`GET /permissions`).
3. יוצר משתמש: `POST /users` עם `role_id` ו-`synagogue_ids` (או `all_synagogues: true`).
4. הגבאי נכנס, ו-`GET /auth/me` אומר לפרונט מה להציג. כפתור "הוספת מניין" רק אם `permissions` כולל `minyanim:create`.
