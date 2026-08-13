import {
  formatPlaytestReports,
  getPlaytestReport,
  listPlaytestReports,
  recordPlaytestReport,
  reproducePlaytestReport,
  resolvePlaytestReport,
  supersedePlaytestReport,
  type PlaytestArea,
  type PlaytestSeverity,
} from "../playtest-reports";
import { currentQualityAuditInputRevision } from "./quality-certificate";
import { verifyFeedbackReport } from "./verify-feedback";

interface ReportArgs {
  gameDir: string;
  session: string;
  area: PlaytestArea;
  severity: PlaytestSeverity;
  title: string;
  origin?: "player-feedback/web";
  details?: string;
  target?: string;
  pretty: boolean;
}

interface ReportsArgs {
  gameDir: string;
  session?: string;
  format: "json" | "table";
  status: "open" | "resolved" | "superseded" | "all";
}

interface ResolveArgs {
  gameDir: string;
  id: string;
  session?: string;
  resolution?: string;
  pretty: boolean;
}

interface SupersedeArgs {
  gameDir: string;
  id: string;
  session?: string;
  reason: string;
  pretty: boolean;
}

interface ReproduceArgs {
  gameDir: string;
  id: string;
  to: string;
  session?: string;
  pretty: boolean;
}

interface VerifyFeedbackCommandArgs {
  gameDir: string;
  reportId: string;
  sessionPrefix: string;
  resolution: string;
  pretty: boolean;
}

interface InspectReportArgs {
  gameDir: string;
  id: string;
  session?: string;
  pretty: boolean;
}

export async function reportCommand(args: ReportArgs): Promise<void> {
  const { origin, pretty: _pretty, ...reportArgs } = args;
  const projectInputRevision = origin === "player-feedback/web"
    ? await currentQualityAuditInputRevision(args.gameDir)
    : null;
  const report = await recordPlaytestReport({
    ...reportArgs,
    ...(origin === "player-feedback/web"
      ? {
          origin: {
            kind: "player-feedback" as const,
            surface: "web" as const,
            ...(projectInputRevision ? { projectInputRevision } : {}),
          },
        }
      : {}),
  });
  process.stdout.write(
    (args.pretty ? JSON.stringify(report, null, 2) : JSON.stringify(report)) +
      "\n",
  );
}

export async function reportsCommand(args: ReportsArgs): Promise<void> {
  const allReports = await listPlaytestReports(args.gameDir, args.session);
  const reports =
    args.status === "all"
      ? allReports
      : allReports.filter((report) => report.status === args.status);
  process.stdout.write(
    args.format === "json"
      ? JSON.stringify(reports, null, 2) + "\n"
      : formatPlaytestReports(reports) + "\n",
  );
}

export async function inspectReportCommand(args: InspectReportArgs): Promise<void> {
  const report = await getPlaytestReport(args.gameDir, args.id, args.session);
  process.stdout.write(
    (args.pretty ? JSON.stringify(report, null, 2) : JSON.stringify(report)) + "\n",
  );
}

export async function resolveCommand(args: ResolveArgs): Promise<void> {
  const report = await resolvePlaytestReport(args);
  process.stdout.write(
    (args.pretty ? JSON.stringify(report, null, 2) : JSON.stringify(report)) +
      "\n",
  );
}

export async function supersedeCommand(args: SupersedeArgs): Promise<void> {
  const report = await supersedePlaytestReport(args);
  process.stdout.write(
    (args.pretty ? JSON.stringify(report, null, 2) : JSON.stringify(report)) +
      "\n",
  );
}

export async function verifyFeedbackCommand(
  args: VerifyFeedbackCommandArgs,
): Promise<void> {
  const result = await verifyFeedbackReport(args);
  process.stdout.write(
    (args.pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result)) + "\n",
  );
  if (result.status === "failed") process.exitCode = 1;
}

export async function reproduceCommand(args: ReproduceArgs): Promise<void> {
  const result = await reproducePlaytestReport(args);
  process.stdout.write(
    (args.pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result)) +
      "\n",
  );
}
