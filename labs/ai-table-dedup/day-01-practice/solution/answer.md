# Sample answer: duplicate candidates and reconciliation

This is a paper answer using fictional records and a hypothetical decision. No real business confirmation, backup, file modification or deletion occurred. Actual rules belong to an authorized business owner.

## 1. Comparison scope and observations

- Each row is an order-line record; R01 and similar labels only track the exercise and are not business unique keys.
- Compared fields: order ID, item, quantity and recorded amount.
- One order can have multiple lines, so an order ID may distinguish orders without distinguishing every row. No line ID or unique order-plus-item rule is provided here.
- R01/R02 match across the four displayed fields. They are candidates; a person must check actual sources to establish a business duplicate.
- R01/R03 have the same item, quantity and amount but different order IDs; do not merge automatically. R04/R05 share an order ID but have different items and amounts; do not delete by order ID.
- R06 has no supplied order ID; do not invent one. R07/R08 have the same order ID, item and quantity but amounts of 30 and 35 yuan; retain pending review without choosing a value.

## 2. Request and protection plan

> Analyze only the provided fictional order lines and compare order ID, item, quantity and amount. List candidates identical across those fields, similar rows, missing IDs and amount conflicts, with row labels and reasons. Preserve the original values; do not merge, rewrite or delete automatically. Mark findings for human review and do not invent business rules.

- Ask the business owner about row meaning, unique key and its scope, how to investigate a missing ID, and whether R07/R08 are different lines or another status.
- In real work an authorized person should preserve a recoverable source version and controlled working copy in an approved location and record versions and permissions. No backup or restore was performed here.
- A prompt is not an access control; use actual permissions and workflow to prevent automatic writing in the real tool. Do not upload real personal information to AI.

## 3. Paper calculation under the scenario assumption

- Original R01 through R08: 8 rows; 30 + 30 + 30 + 20 + 5 + 30 + 30 + 35 = 210 yuan.
- Only for the exercise, suppose the fictional owner confirmed R02 as a repeated import of R01 and decided to exclude it from this statistic. Without that assumption R02 is still pending.
- Excluded: R02, one row and 30 yuan. Retained for now: R01, R03, R04, R05, R06, R07 and R08.
- Result: 8 − 1 = 7 rows; 210 − 30 = 180 yuan.
- Pending: R06 + R07 + R08 = 30 + 30 + 35 = 95 yuan.
- Other rows retained for now: R01 + R03 + R04 + R05 = 30 + 30 + 20 + 5 = 85 yuan; 85 + 95 = 180 yuan.

## 4. Review and handoff

- Compare the row list and original values with the source version, confirming only R02 was excluded under the assumption. Then reconcile row counts and amounts; a matching total alone cannot prove the list is right.
- The owner must resolve R06's missing ID, the R07/R08 conflict and the business unique key. The provisional 180 includes 95 yuan pending review and is not final revenue; the 85 is not automatically confirmed revenue either.
- Record the source version, comparison fields, row labels, original values, decisions, reviewer and actual date. There is no real reviewer or date in this scenario; backup, deletion and restoration were not performed.
