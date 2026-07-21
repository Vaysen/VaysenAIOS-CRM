export type ResearchExecutionOptions = {
  agentRunId?: string;
};

export type ResearchAgentResult = {
  reportId: string;
  html: string;
  json: any;
  title: string;
};
