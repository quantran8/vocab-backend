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
  /** Daily review only: the topic label shown with the reviewed word. */
  sourceTopic?: { id: string; name: string };
}

export interface PlanLearnStep {
  id: string;
  meaningId: string;
  ordinal: number;
  clientCard: unknown;
  firstRecallTaskId: string;
  /** Topic the Meaning was planned from; absent on plans issued before it existed. */
  viaTopicId?: string | null;
  knownCheckTaskId?: string;
  skippableTaskIds?: string[];
}

/** Immutable snapshot of one issued session, stored whole on `learning_sessions.plan`. */
export interface SessionPlan {
  tasks: PlanTask[];
  learnSteps: PlanLearnStep[];
}
