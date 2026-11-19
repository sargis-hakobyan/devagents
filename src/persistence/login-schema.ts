export const loginSchema = `
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK (role='admin'));
CREATE TABLE IF NOT EXISTS password_accounts (username TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id), salt TEXT NOT NULL, hash TEXT NOT NULL);
`;
