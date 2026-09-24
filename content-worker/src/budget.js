// Per-job AI budget. Checked BEFORE every model call so a job can never run
// uncontrolled. Usage from previous attempts of the same article counts too,
// so a retry cannot reset the budget.

export class BudgetExceededError extends Error {
  constructor(message) {
    super(message);
    this.name = "BudgetExceededError";
    this.code = "BUDGET_EXCEEDED";
    this.retryable = false;
  }
}

export class Budget {
  constructor(limits, prior = {}) {
    this.limits = limits;
    this.calls = Number(prior.calls) || 0;
    this.tokens = Number(prior.tokens) || 0;
    this.cost = Number(prior.cost) || 0;
  }

  assertCanCall(task) {
    if (this.limits.maxAiCalls <= 0) throw new BudgetExceededError(`AI calls are disabled for this job (task ${task})`);
    if (this.calls >= this.limits.maxAiCalls) {
      throw new BudgetExceededError(`AI call budget exhausted (${this.calls}/${this.limits.maxAiCalls}) before ${task}`);
    }
    if (this.tokens >= this.limits.maxTotalTokens) {
      throw new BudgetExceededError(`Token budget exhausted (${this.tokens}/${this.limits.maxTotalTokens}) before ${task}`);
    }
    if (this.limits.maxBudgetUsd > 0 && this.cost >= this.limits.maxBudgetUsd) {
      throw new BudgetExceededError(`Cost budget exhausted ($${this.cost.toFixed(4)}/$${this.limits.maxBudgetUsd}) before ${task}`);
    }
  }

  record(usage) {
    this.calls += Number(usage?.calls ?? 1) || 0;
    this.tokens += (Number(usage?.inputTokens) || 0) + (Number(usage?.outputTokens) || 0);
    if (usage?.estimatedCost !== null && usage?.estimatedCost !== undefined) this.cost += Number(usage.estimatedCost) || 0;
  }

  snapshot() {
    return { calls: this.calls, tokens: this.tokens, cost: this.cost, limits: this.limits };
  }
}
