// 预算熔断：软上限提醒 + 硬上限停机。
//
// 关键语义是「事前预留」而不是「事后统计」：每次要花钱之前先把这笔钱预扣掉，
// 扣不动就直接不发这个请求。事后统计只能告诉你「已经超了」，那时钱已经花出去了。

export class BudgetExceededError extends Error {
  constructor(
    readonly spentCny: number,
    readonly wouldSpendCny: number,
    readonly hardCny: number,
    readonly stage: string
  ) {
    super(
      `硬上限熔断：已花 ¥${spentCny.toFixed(4)}，${stage} 这一步还要 ¥${wouldSpendCny.toFixed(4)}，` +
        `合计超过硬上限 ¥${hardCny.toFixed(4)}，本次运行到此为止`
    )
    this.name = 'BudgetExceededError'
  }
}

export type BudgetOptions = { softCny: number; hardCny: number; onSoft?: (spent: number) => void }

export class Budget {
  private spent = 0
  private softFired = false

  constructor(private readonly opts: BudgetOptions) {}

  get spentCny(): number {
    return Number(this.spent.toFixed(4))
  }

  get remainingToHardCny(): number {
    return Number((this.opts.hardCny - this.spent).toFixed(4))
  }

  /** 花钱之前调用。超硬上限就抛错，调用方负责安全停机；超软上限只提醒一次。 */
  reserve(stage: string, amountCny: number): void {
    if (this.spent + amountCny > this.opts.hardCny) {
      throw new BudgetExceededError(this.spent, amountCny, this.opts.hardCny, stage)
    }
    this.spent += amountCny
    if (!this.softFired && this.spent > this.opts.softCny) {
      this.softFired = true
      this.opts.onSoft?.(this.spentCny)
    }
  }

  /** 失败或命中安全审核的视频不扣费，所以要把预扣的钱退回来。 */
  refund(amountCny: number): void {
    this.spent = Math.max(0, this.spent - amountCny)
  }
}
