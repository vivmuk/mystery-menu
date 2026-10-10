/** Client → server and server → client event payloads for the lobby. */

export interface JoinRequest {
  code: string;
  name: string;
  colour: string;
}

export interface JoinErrorPayload {
  reason: string;
}
