type LogLevel = "debug" | "info" | "warn" | "error";

export type LogRecord = {
  ts: string;
  level: LogLevel;
  service: string;
  event: string;
  [key: string]: unknown;
};

export class Logger {
  private readonly records: LogRecord[] = [];
  private readonly maxRecords = 1000;

  constructor(private readonly service = "kanban-symphony") {}

  debug(event: string, data: Record<string, unknown> = {}) {
    this.write("debug", event, data);
  }

  info(event: string, data: Record<string, unknown> = {}) {
    this.write("info", event, data);
  }

  warn(event: string, data: Record<string, unknown> = {}) {
    this.write("warn", event, data);
  }

  error(event: string, data: Record<string, unknown> = {}) {
    this.write("error", event, data);
  }

  recent(limit = 200): LogRecord[] {
    return this.records.slice(-limit).toReversed();
  }

  private write(level: LogLevel, event: string, data: Record<string, unknown>) {
    const record = {
      ts: new Date().toISOString(),
      level,
      service: this.service,
      event,
      ...data,
    };
    this.records.push(record);
    if (this.records.length > this.maxRecords)
      this.records.splice(0, this.records.length - this.maxRecords);
    const line = JSON.stringify(record);
    if (level === "error") console.error(line);
    else console.log(line);
  }
}
