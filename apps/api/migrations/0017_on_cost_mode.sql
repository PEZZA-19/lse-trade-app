-- Tax and on-costs can be a fixed £/h (all existing rows) or a percentage of the base cost.
-- on_cost_pence always holds the £/h amount, so reports keep adding base + on-cost unchanged; in
-- percent mode the check below keeps it equal to base × % rounded half up to the penny.
ALTER TABLE member_costs
  ADD COLUMN on_cost_mode text NOT NULL DEFAULT 'fixed' CHECK (on_cost_mode IN ('fixed', 'percent')),
  ADD COLUMN on_cost_bp integer CHECK (on_cost_bp BETWEEN 0 AND 20000);
ALTER TABLE member_costs ADD CONSTRAINT member_costs_on_cost_consistent CHECK (
  (on_cost_mode = 'fixed' AND on_cost_bp IS NULL)
  OR (on_cost_mode = 'percent' AND on_cost_bp IS NOT NULL
      AND on_cost_pence = (base_cost_pence * on_cost_bp + 5000) / 10000)
);
