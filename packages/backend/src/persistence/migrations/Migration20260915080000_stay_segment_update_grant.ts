import { Migration } from '@mikro-orm/migrations';

export class Migration20260915080000_stay_segment_update_grant extends Migration {
  override async up(): Promise<void> {
    this.addSql(`grant update on "stay_segment" to "hotel_api"`);
  }

  override async down(): Promise<void> {
    this.addSql(`revoke update on "stay_segment" from "hotel_api"`);
  }
}
