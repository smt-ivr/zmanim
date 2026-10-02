# zmanim-api

API לניהול זמני מניינים — Cloudflare Workers + D1. גרסה 2: ארכיטקטורה מסודרת, הרשאות מבוססות תפקידים, אבטחה מלאה.

## מי יכול מה

| סוג משתמש | מה הוא | מה הוא רואה ומנהל |
|---|---|---|
| **מנהל ראשי** (`is_super_admin`) | כל ההרשאות, תמיד | הכול. ניהול משתמשים, תפקידים והגדרות בסיס |
| **מנהל משנה** | תפקיד עם הרשאות שהמנהל הראשי מגדיר (אפשר ליצור תפקידים חדשים) + היקף: כל בתי הכנסת או רשימה | רק מה שההרשאות וההיקף מתירים |
| **גבאי** | תפקיד מובנה: עריכת בית הכנסת, מיקומים ומניינים | בית כנסת אחד או כמה, לפי השיוך |
| **ציבור** | ללא התחברות | `GET /public/minyanim`, `GET /public/synagogues` בלבד |

**שני מושגים בלבד:**

1. **הרשאות (permissions)** — *מה* מותר לעשות (`minyanim:create`, `users:update` ...). קבוצת הרשאות נקראת **תפקיד (role)**.
2. **היקף (scope)** — *איפה* מותר לעשות זאת: `all_synagogues` (כל בתי הכנסת) או רשימת בתי כנסת מסוימים.

פעולה מותרת רק אם יש גם הרשאה וגם גישה לבית הכנסת הרלוונטי. קריאת נתונים בתוך ההיקף לא דורשת הרשאה מיוחדת.

### מניעת הסלמת הרשאות

מנהל משנה לא יכול לתת למישהו יותר ממה שיש לו עצמו:

- אפשר להקצות רק תפקיד שכל הרשאותיו נמצאות גם אצל המקצה.
- אפשר לשייך רק בתי כנסת שהמקצה עצמו מורשה אליהם; `all_synagogues` רק למי שיש לו היקף מלא.
- אי אפשר לנהל משתמש שיש לו הרשאות או היקף גדולים משלך, ואי אפשר לגעת במנהל ראשי.
- רק מנהל ראשי יכול למנות מנהל ראשי או לערוך תפקידי מערכת.
- אף אחד לא יכול לשנות לעצמו תפקיד / היקף / סטטוס או למחוק את עצמו.
- תמיד חייב להישאר מנהל ראשי פעיל אחד לפחות.

## הרשאות במערכת

| מפתח | משמעות |
|---|---|
| `synagogues:create` / `update` / `delete` | יצירה, עריכה ומחיקה של בתי כנסת |
| `locations:create` / `update` / `delete` | מיקומים בתוך בית כנסת |
| `minyanim:create` / `update` / `delete` | מניינים |
| `users:read` / `create` / `update` / `delete` | ניהול משתמשים (רק מי שבהישג ידך) |
| `roles:manage` | יצירה ועריכה של תפקידים |
| `settings:manage` | אזורים, סוגי תפילה, סוגי זמן, עונות |

תפקידים מובנים (נוצרים במיגרציה): **גבאי** ו-**מנהל משנה**. המנהל הראשי יכול ליצור תפקידים נוספים דרך `POST /roles`, והרשימה המלאה זמינה ב-`GET /permissions`.

## מבנה הפרויקט

```
src/
  index.js            נקודת כניסה: ניתוב, אימות, טיפול אחיד בשגיאות, CORS, cron
  router.js           ראוטר קטן עם פרמטרים בנתיב
  routes.js           טבלת כל ה-endpoints במקום אחד
  config.js           קבועים (TTL של סשן, מגבלות ניסיונות התחברות וכו')
  auth/
    permissions.js    קטלוג הרשאות + בדיקות הרשאה והיקף
    profiles.js       טעינת משתמש + תפקיד + היקף
    session.js        יצירת סשן ואימות טוקן
    throttle.js       הגבלת ניסיונות התחברות
  handlers/           שכבת ה-HTTP: אימות קלט, בדיקת הרשאה, תגובה
  services/minyanim.js  שאילתות וולידציה עסקית של מניינים
  lib/                שגיאות, תגובות, ולידציה, סיסמאות, עזרי DB
migrations/           0000 סכימת בסיס (בטוחה לבסיס קיים), 0001 שדרוג
scripts/              יצירת מנהל ראשי, הצפנת סיסמאות ישנות, ניקוי לאחר המעבר
test/                 30 בדיקות אינטגרציה מול סכימה אמיתית (כולל מעבר מהמבנה הישן)
docs/API.md           מדריך ה-API המלא
```

כלל הברזל: **handler** מאמת קלט, בודק הרשאה ומחזיר תגובה. **service** מחזיק לוגיקה עסקית. כל גישה ל-DB היא בשאילתות עם פרמטרים.

## העלאה לאוויר: צעד אחר צעד

> הסכימה של הטבלאות הקיימות הוסקמה מהקוד הישן (לא היה לי קובץ סכימה). **לפני שמריצים**, השוו אותה למציאות.

1. **גיבוי ובדיקת סכימה**
   ```bash
   wrangler d1 export zmanim --remote --output backup.sql
   wrangler d1 execute zmanim --remote --command "SELECT name, sql FROM sqlite_master WHERE type='table'"
   ```
   ודאו שבטבלאות `Users`, `Synagogues` וכו' העמודות תואמות ל-`migrations/0000_base_schema.sql`, ושלכל טבלה יש `id` כמפתח ראשי. אם יש עמודות נוספות שהממשק עורך (באזורים, סוגי תפילה וכו'), הוסיפו אותן ב-`LOOKUPS` בקובץ `src/handlers/lookups.js` (שורה אחת לכל עמודה).
2. **מיגרציה**
   ```bash
   npm install
   npm run db:migrate:remote
   ```
   המיגרציה רק מוסיפה: שום עמודה או טבלה קיימת לא נמחקת. משתמשים קיימים הופכים אוטומטית: `is_admin=1` ← מנהל ראשי; כל השאר ← תפקיד **גבאי** עם בתי הכנסת מתוך `synagogue_ids` הישן. אם המיגרציה נכשלת על אינדקס ייחודי, יש משתמשים כפולים באימייל/טלפון ויש לאחד אותם.
3. **פריסה**: `npm run deploy`.
4. **סיסמאות**: משתמשים קיימים נכנסים עם הסיסמה הישנה, והמערכת מצפינת אותה בכניסה הראשונה. למי שלא נכנס זמן רב, הריצו `scripts/hash-legacy-passwords.mjs` (ההוראות בראש הקובץ). אחרי שאין עוד סיסמאות גלויות, הריצו ידנית את `scripts/post-migration-cleanup.sql`.
5. **מנהל ראשי חדש** (בבסיס נתונים ריק): `node scripts/create-admin.mjs "שם" "mail@x.com" "" "סיסמה" > admin.sql && wrangler d1 execute zmanim --remote --file admin.sql`.
6. **עדכון הפרונט**: ראו טבלת המיפוי למטה.

אפשרות: להגביל CORS לדומיין שלכם דרך `ALLOWED_ORIGINS` ב-`wrangler.toml`.

## מיפוי מה-API הישן לחדש

כל הנתיבים מתחת ל-`/zmanim/api/v1`. התגובה אחידה: `{ success, data, meta? }` או `{ success:false, error:{ code, message, details?, request_id } }`.

| ישן | חדש |
|---|---|
| `POST /login` | `POST /auth/login` (מחזיר גם את פרופיל המשתמש) |
| `GET /me` | `GET /auth/me` (כולל `permissions`, `synagogue_ids`, `all_synagogues`) |
| `GET /meta` | `GET /meta` (שדות באותיות קטנות: `prayer_types`, `time_types`, `seasons`, `areas`; בוליאנים אמיתיים) |
| `POST /synagogues {action, id, data}` | `POST /synagogues`, `PATCH /synagogues/:id`, `DELETE /synagogues/:id` |
| `POST /locations {action...}` | `POST /locations`, `PATCH /locations/:id`, `DELETE /locations/:id` |
| `POST /minyanim {action...}` | `POST /minyanim`, `PATCH /minyanim/:id`, `DELETE /minyanim/:id` |
| `POST /users {action...}` | `POST /users`, `PATCH /users/:id`, `DELETE /users/:id` |
| `GET/POST /settings?table=X` | `/areas`, `/prayer-types`, `/time-types`, `/seasons` (כל אחד עם GET/POST/PATCH/DELETE) |
| `GET /public/minyanim` | `GET /public/minyanim` (עם סינון ו-cache) |
| — | `/roles`, `/permissions`, `/auth/logout`, `/auth/change-password`, `/public/synagogues`, `/health` |

שינויים בהתנהגות שהפרונט צריך להכיר:

- **משתמשים:** במקום `is_admin` ו-`synagogue_ids` (מחרוזת JSON) יש `is_super_admin`, `role_id`, `all_synagogues` ו-`synagogue_ids` (מערך מספרים).
- **סוג זמן:** `allowed_prayer_ids` הוא מערך, ונאכף כעת בשרת (קודם רק הוצג).
- **מחיקות:** מחיקת בית כנסת עם תוכן דורשת `?cascade=true`; מחיקת מיקום מנתקת אותו ממניינים ולא מוחקת אותם; מחיקת ערך בשימוש מחזירה 409.
- **טוקנים ישנים לא יעבדו:** כולם יתחברו מחדש פעם אחת.

## אבטחה

סיסמאות PBKDF2-SHA256 עם salt; טוקנים נשמרים כ-hash עם תפוגה (30 יום), מקסימום 5 מכשירים, ויציאה / החלפת סיסמה מנתקות סשנים; נעילה אחרי 5 כשלונות (לפי משתמש) ו-30 (לפי IP); תגובה זהה למשתמש לא קיים וסיסמה שגויה, כולל איזון זמן; אין SQL דינמי מקלט משתמש; קודי סטטוס נכונים (400/401/403/404/409/429) ושגיאות פנימיות לא נחשפות (רק `request_id` ללוגים); ניקוי יומי אוטומטי.

## פיתוח ובדיקות

```bash
npm test          # 30 בדיקות, ללא רשת. מריצות את המיגרציות האמיתיות על נתונים "ישנים"
npm run dev       # wrangler dev
```

לרשימת ה-endpoints המלאה עם הרשאות ודוגמאות: [docs/API.md](docs/API.md).

## הרחבות עתידיות

הרשאות לפי אזור (`Areas`) במקום רשימת בתי כנסת; יומן פעולות (Audit log); איפוס סיסמה במייל / SMS; Rate limit כללי ב-Cloudflare WAF. כל אחד מהם נכנס בלי לשנות את המבנה הקיים.
