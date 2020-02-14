import {
  Server,
  CustomTransportStrategy,
  IncomingRequest,
  ReadPacket,
  PacketId,
} from '@nestjs/microservices';
import { isUndefined } from '@nestjs/common/utils/shared.utils';
import { NO_MESSAGE_HANDLER } from '@nestjs/microservices/constants';

import { FayeContext } from '../ctx-host/faye-context';
import { FayeClient } from '../../external/faye-client.interface';
import { ERROR_EVENT } from '../../constants';
import { FayeOptions } from '../../interfaces/faye-options.interface';

import { Observable } from 'rxjs';

import * as faye from 'faye';

export class ServerFaye extends Server implements CustomTransportStrategy {
  private fayeClient: FayeClient;

  constructor(private readonly options: FayeOptions) {
    super();

    this.initializeSerializer(options);
    this.initializeDeserializer(options);
  }

  public listen(callback: () => void) {
    this.fayeClient = this.createFayeClient();
    this.start(callback);
  }

  public createFayeClient(): FayeClient {
    const { url, serializer, deserializer, ...options } = this.options;
    return new faye.Client(url, options);
  }

  public close() {
    this.fayeClient = null;
  }

  public start(callback) {
    this.handleError(this.fayeClient);
    this.bindEvents(this.fayeClient);
    callback();
  }

  public bindEvents(client: FayeClient) {
    const registeredPatterns = [...this.messageHandlers.keys()];
    registeredPatterns.forEach(pattern => {
      const { isEventHandler } = this.messageHandlers.get(pattern);
      client.subscribe(
        isEventHandler ? pattern : `${pattern}_ack`,
        this.getMessageHandler(pattern, client).bind(this),
      );
    });
  }

  public getMessageHandler(channel: string, client: FayeClient): Function {
    return async (buffer: any) => {
      return this.handleMessage(channel, buffer, client);
    };
  }

  public async handleMessage(
    channel: any,
    buffer: string,
    pub: FayeClient,
  ): Promise<any> {
    const fayeCtx = new FayeContext([channel]);
    const rawPacket = this.parseMessage(buffer);
    const message = this.deserializer.deserialize(rawPacket, { channel });
    if (isUndefined((message as IncomingRequest).id)) {
      return this.handleEvent(channel, message, fayeCtx);
    }
    const pattern = message.pattern.replace(/_ack$/, '');
    const publish = this.getPublisher(
      pub,
      pattern,
      (message as IncomingRequest).id,
    );

    const handler = this.getHandlerByPattern(pattern);

    if (!handler) {
      const status = 'error';
      const noHandlerPacket = {
        id: (message as IncomingRequest).id,
        status,
        err: NO_MESSAGE_HANDLER,
      };
      return publish(noHandlerPacket);
    }
    const response$ = this.transformToObservable(
      await handler(message.data, fayeCtx),
    ) as Observable<any>;
    // tslint:disable-next-line: no-unused-expression
    response$ && this.send(response$, publish);
  }

  public getPublisher(client: FayeClient, pattern: any, id: string): any {
    return (response: any) => {
      Object.assign(response, { id });
      const outgoingResponse = this.serializer.serialize(response);

      return client.publish(
        this.getResQueueName(pattern),
        JSON.stringify(outgoingResponse),
      );
    };
  }

  public parseMessage(content: any): ReadPacket & PacketId {
    try {
      return JSON.parse(content);
    } catch (e) {
      return content;
    }
  }

  public getResQueueName(pattern: string): string {
    return `${pattern}_res`;
  }

  public handleError(stream: any) {
    stream.on(ERROR_EVENT, (err: any) => {
      this.logger.error('Faye Server offline!');
      this.close();
    });
  }
}
