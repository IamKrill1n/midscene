export interface ReportDownloadRequest {
  content: string;
  defaultFileName: string;
}

export type ReportDownloadHandler = (
  request: ReportDownloadRequest,
) => void | Promise<void>;
