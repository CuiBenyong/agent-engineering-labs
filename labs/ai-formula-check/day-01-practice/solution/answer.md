# Suggested answer

- Objective: multiply unit price by quantity on each row, using one fictional currency unit and excluding taxes, shipping, discounts and returns.
- Row 2: 12.5 × 2 = 25; row 3: 8 × 3 = 24; row 4: 10 × 0 = 0; total 49.
- `=B2*C2` references row 2's unit price B2 and quantity C2 and multiplies them.
- In common syntax, `=SUM(D2:D4)` includes D2, D3 and D4; verify the actual program's syntax and locale settings.
- Adding only D2 and D4 gives 25 and omits D3's 24.
- Blank: does a missing quantity mean not recorded, unconfirmed or genuinely zero? Ask the data owner before deciding.
- Privacy: verify authority to use or upload real data and review the provider's data-handling terms; start with fictional data where possible.
- Status: this is a paper calculation, not proof of execution in a particular program or verification of real business data.
