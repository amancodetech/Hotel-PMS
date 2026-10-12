import { Migration } from '@mikro-orm/migrations';

export class Migration20260913170000_identity_flow_state_columns extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "auth_flow"
        alter column "state" type varchar(128),
        alter column "nonce" type varchar(128)
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table "auth_flow"
        alter column "state" type char(64),
        alter column "nonce" type char(64)
    `);
  }
}
