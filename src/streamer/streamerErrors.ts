import { StreamerCommandResponse } from '../types/streamer.js';


export class StreamerCommandError extends Error {
  readonly code: number;
  readonly service: string;
  readonly command: string;
  readonly requestid: string;
  readonly brokerMessage: string;

  constructor(response: StreamerCommandResponse) {
    super(
      'Streamer command rejected: ' +
        response.service +
        '/' +
        response.command +
        ' code=' +
        response.content.code +
        ' ' +
        response.content.msg,
    );
    this.name = 'StreamerCommandError';
    this.code = response.content.code;
    this.service = response.service;
    this.command = response.command;
    this.requestid = String(response.requestid);
    this.brokerMessage = response.content.msg;
  }
}

export class StreamerCommandTimeoutError extends Error {
  readonly service: string;
  readonly command: string;
  readonly requestid: string;
  readonly timeoutMs: number;

  constructor(details: { service: string; command: string; requestid: string; timeoutMs: number }) {
    super(
      'Timed out waiting for Streamer ACK after ' +
        details.timeoutMs +
        'ms: ' +
        details.service +
        '/' +
        details.command +
        ' requestid=' +
        details.requestid,
    );
    this.name = 'StreamerCommandTimeoutError';
    this.service = details.service;
    this.command = details.command;
    this.requestid = details.requestid;
    this.timeoutMs = details.timeoutMs;
  }
}


export class StreamerConnectionError extends Error {
  readonly code: number | undefined;

  constructor(message: string, code?: number) {
    super(message);
    this.name = 'StreamerConnectionError';
    this.code = code;
  }
}

/** The client proved that a service command never reached socket.send(). */
export class StreamerCommandNotSentError extends StreamerConnectionError {
  constructor(message: string) {
    super(message);
    this.name = 'StreamerCommandNotSentError';
  }
}
