# Fictional order duplicate review and reconciliation

Complete `starter/answer.md` on paper or in a document, then compare `solution/answer.md`. Every record and decision is fictional. Do not upload real personal information or let AI automatically delete any record. The exercise does not operate on a real file or claim that a backup was created or restored.

## Fictional order lines

Each row is an order-line record. R labels are for exercise tracking, not a business unique key. Amounts are recorded values in Chinese yuan, not verified revenue. Compare order ID, item, quantity and recorded amount.

| Row label | Order ID | Item | Quantity | Recorded amount (yuan) |
| --- | --- | --- | --- | --- |
| R01 | O101 | Notebook | 1 | 30 |
| R02 | O101 | Notebook | 1 | 30 |
| R03 | O102 | Notebook | 1 | 30 |
| R04 | O103 | Pencil | 2 | 20 |
| R05 | O103 | Eraser | 1 | 5 |
| R06 | Not supplied | Notebook | 1 | 30 |
| R07 | O104 | Notebook | 1 | 30 |
| R08 | O104 | Notebook | 1 | 35 |

## Four steps

1. Name the comparison fields. Identify candidates identical across those fields, similar rows that cannot be merged automatically, a missing order ID and an amount conflict. Explain why an order ID may not uniquely identify a line.
2. Write a request using fictional data that returns candidates and reasons only. List plans for backup, permissions and human review; do not claim the plans have been performed.
3. Calculate the count and recorded-amount sum for all eight rows. Then work on paper under this assumption only: a fictional owner has confirmed R02 is a repeated import of R01 and decides to exclude R02 from this statistic; R06, R07 and R08 remain pending and retained. Calculate the retained count, total and pending amount.
4. Record which rows are excluded or retained, reconcile before and after, and list questions for the owner. Explain why the provisional total is not final revenue.

## Completion criteria

R01/R02 match across the four fields but need human confirmation. Do not merge R01/R03 or R04/R05 automatically; R06 and R07/R08 remain pending. The baseline is 8 rows and 210 yuan. Only under the scenario's assumption, excluding R02 leaves 7 rows and 180 yuan, including 95 yuan pending review. No original record is actually deleted.
