import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

const db = drizzle({ connection: process.env.DATABASE_URL });
await migrate(db, { migrationsFolder: './drizzle' });
console.log('Migrations applied');
