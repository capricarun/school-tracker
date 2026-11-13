// All configuration comes from environment variables (see .env.example).
export const config = {
  port: Number(process.env.PORT || 3000),
  dataDir: process.env.DATA_DIR || './data',
  // Hosted SQLite (Turso). When set, DATA_DIR is not used — needed on hosts without a disk.
  databaseUrl: process.env.TURSO_DATABASE_URL || '',
  databaseToken: process.env.TURSO_AUTH_TOKEN || '',
  publicUrl: (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, ''),
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  claudeModel: process.env.CLAUDE_MODEL || 'claude-haiku-5-5',
  vapidPublic: process.env.VAPID_PUBLIC_KEY || '',
  vapidPrivate: process.env.VAPID_PRIVATE_KEY || '',
  vapidSubject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
  // Reminders whose time passed while the server was down are still sent if
  // they are less than this old.
  graceMinutes: Number(process.env.REMINDER_GRACE_MINUTES || 180),
  tickSeconds: Number(process.env.SCHEDULER_TICK_SECONDS || 60),
  allowSignup: process.env.ALLOW_SIGNUP !== 'false',
  signupsPerHour: Number(process.env.SIGNUPS_PER_HOUR || 5),
  // Attachments are stored in the database (works on Turso too). Photos are shrunk in the browser first.
  maxFileMb: Number(process.env.MAX_FILE_MB || 4),
  maxFamilyStorageMb: Number(process.env.MAX_FAMILY_STORAGE_MB || 300),
};
