import {
  formatPlaytestReports,
  listPlaytestReports,
  recordPlaytestReport,
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
}

export async function reportCommand(args: ReportArgs): Promise<void> {
  const report = await recordPlaytestReport(args);
  process.stdout.write(
    (args.pretty ? JSON.stringify(report, null, 2) : JSON.stringify(report)) +
      "\n",
  );
}

export async function reportsCommand(args: ReportsArgs): Promise<void> {
  const reports = await listPlaytestReports(args.gameDir, args.session);
  process.stdout.write(
    args.format === "json"
      ? JSON.stringify(reports, null, 2) + "\n"
      : formatPlaytestReports(reports) + "\n",
  );
}
