import {
  formatPlaytestReports,
  listPlaytestReports,
  recordPlaytestReport,
  resolvePlaytestReport,
  type PlaytestArea,
  type PlaytestSeverity,
} from "../playtest-reports";

interface ReportArgs {
  gameDir: string;
  session: string;
  area: PlaytestArea;
  severity: PlaytestSeverity;
  title: string;
  details?: string;
  target?: string;
  pretty: boolean;
}

interface ReportsArgs {
  gameDir: string;
  session?: string;
  format: "json" | "table";
  status: "open" | "resolved" | "all";
}

interface ResolveArgs {
  gameDir: string;
  id: string;
  session?: string;
  resolution?: string;
  pretty: boolean;
}

export async function reportCommand(args: ReportArgs): Promise<void> {
  const report = await recordPlaytestReport(args);
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

export async function resolveCommand(args: ResolveArgs): Promise<void> {
  const report = await resolvePlaytestReport(args);
  process.stdout.write(
    (args.pretty ? JSON.stringify(report, null, 2) : JSON.stringify(report)) +
      "\n",
  );
}
