export { App } from "./app";
export { loadGame } from "./loader";
export { play } from "./play";
export {
  analyzeScriptCoverage,
  collectScriptCoverage,
} from "./commands/coverage";
export type {
  CoverageStatus,
  ScriptCoverageReport,
  ScriptCoverageRow,
} from "./commands/coverage";
export {
  analyzeChoiceCoverage,
  collectAuthoredChoices,
  collectChoiceCoverage,
  formatChoiceCoverage,
} from "./commands/choice-coverage";
export { runChoiceCoverageWorkItem } from "./commands/cover-choice";
export type {
  CoverChoiceArgs,
  CoverChoiceSummary,
} from "./commands/cover-choice";
export { runReachChoice } from "./commands/reach-choice";
export type {
  ReachChoiceArgs,
  ReachChoiceSummary,
} from "./commands/reach-choice";
export {
  buildTranscriptEvents,
  collectSessionTranscript,
  formatSessionTranscript,
} from "./commands/transcript";
export type {
  SessionTranscript,
  TranscriptEvent,
} from "./commands/transcript";
export type {
  ChoiceCoverageEvidence,
  ChoiceCoverageOptionRow,
  ChoiceCoverageReport,
  ChoiceCoverageRow,
  ChoiceCoverageStatus,
  ChoiceCoverageWorkItem,
  AuthoredChoiceRow,
  ChoiceAuthoringWorkItem,
} from "./commands/choice-coverage";
export {
  loadSession,
  saveSession,
  listSessions,
  appendLog,
  sessionDir,
} from "./session";
export {
  PLAYTEST_AREAS,
  PLAYTEST_SEVERITIES,
  formatPlaytestReports,
  listPlaytestReports,
  getPlaytestReport,
  recordPlaytestReport,
  reproducePlaytestReport,
  resolvePlaytestReport,
} from "./playtest-reports";
export type {
  PlaytestArea,
  PlaytestEvidence,
  PlaytestCheckpointRef,
  PlaytestReport,
  PlaytestSeverity,
  RecordPlaytestReportArgs,
  ReproducePlaytestReportArgs,
  ResolvePlaytestReportArgs,
} from "./playtest-reports";
