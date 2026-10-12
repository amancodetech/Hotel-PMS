import type { MealPlan } from '../../property/domain/lifecycle.js';
import type { Currency } from '../../property/domain/lifecycle.js';
import type { RatePlanStatus } from '../domain/rate-lifecycle.js';

export interface RatePlanRow {
  id: string;
  tenant_id: string;
  property_id: string;
  product_id: string;
  code: string;
  name: string;
  currency: Currency;
  occupancy_basis: number;
  meal_plan: MealPlan;
  inclusions: string[];
  cancellation_policy: Record<string, unknown>;
  free_policy: boolean;
  status: RatePlanStatus;
  policy_version: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface RatePolicyVersionRow {
  id: string;
  tenant_id: string;
  property_id: string;
  rate_plan_id: string;
  version_number: number;
  occupancy_basis: number;
  meal_plan: MealPlan;
  inclusions: string[];
  cancellation_policy: Record<string, unknown>;
  free_policy: boolean;
  created_at: string;
}

export interface NightlyPriceRow {
  id: string;
  tenant_id: string;
  property_id: string;
  rate_plan_id: string;
  policy_version_id: string;
  stay_date: string;
  occupancy: number;
  amount: string;
  currency: Currency;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface PriceQuoteRow {
  id: string;
  tenant_id: string;
  property_id: string;
  rate_plan_id: string;
  policy_version_id: string;
  product_id: string;
  currency: Currency;
  start_date: string;
  end_date: string;
  quantity: number;
  adults: number;
  child_ages: number[];
  total_amount: string;
  cells: Array<{
    date: string;
    occupancy: number;
    amount: string;
    quantity: number;
    line_total: string;
  }>;
  inventory_version: number;
  expires_at: string | null;
  created_at: string;
}
