export interface PlanTarget {
  ordinal: number;
  meaningId: string | null;
  pronunciationId: string | null;
}

export interface PlanTask {
  id: string;
  ordinal: number;
  phase: string;
  template: string;
  variant: string | null;
  curatedItemId: string | null;
  clientPayload: unknown;
  serverEvaluation: unknown;
  evaluatorVersion: string;
  targets: PlanTarget[];
}

export interface PlanLearnStep {
  id: string;
  meaningId: string;
  ordinal: number;
  clientCard: unknown;
  firstRecallTaskId: string;
}

/** Immutable snapshot of one issued session, stored whole on `learning_sessions.plan`. */
export interface SessionPlan {
  tasks: PlanTask[];
  learnSteps: PlanLearnStep[];
}
