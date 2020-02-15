import {
  Server,
  CustomTransportStrategy,
  ReadPacket,
} from '@nestjs/microservices';

import { FayeClient } from '../../external/faye-client.interface';
import { ERROR_EVENT } from '../../constants';
import { FayeOptions } from '../../interfaces/faye-options.interface';

import * as faye from 'faye';
import { Observable } from 'rxjs';

export class ServerFaye extends Server implements CustomTransportStrategy {
  // Holds our client interface to the Faye broker.
  private fayeClient: FayeClient;

  constructor(private readonly options: FayeOptions) {
    super();

    // super class establishes the serializer and deserializer; sets up
    // defaults unless overridden via `options`
    this.initializeSerializer(options);
    this.initializeDeserializer(options);
  }

  /**
   * listen() is required by `CustomTransportStrategy` It's called by the
   * framework when the transporter is instantiated, and kicks off a lot of
   * the machinery.
   */
  public listen(callback: () => void) {
    this.fayeClient = this.createFayeClient();
    this.start(callback);
  }

  /**
   * close() is required by `CustomTransportStrategy`...
   */
  public close() {
    this.fayeClient = null;
  }

  /**
   * get and save a connection to the faye broker
   */
  public createFayeClient(): FayeClient {
    // pull out url, and strip serializer and deserializer properties
    // from options so we conform to the `faye.Client()` interface
    const { url, serializer, deserializer, ...options } = this.options;
    return new faye.Client(url, options);
  }

  /**
   * kick things off
   */
  public start(callback) {
    // register handler for error events
    this.handleError(this.fayeClient);

    // register faye message handlers
    // this.subscribeToEvents();
    this.bindHandlers();

    // call any user-supplied callback from `app.listen()` call
    callback();
  }

  /**
   * Register event handlers for all Nest "event" style patterns
   */
  public subscribeToEvents() {
    /**
     * messageHandlers is populated by the Framework (on the Server superclass).
     *
     * It's a map of `pattern` -> `handler` key/value pairs
     * `handler` is a function with an additional boolean property
     * indicating it's Nest type: event or message (request/response)
     */
    this.messageHandlers.forEach((handler, pattern) => {
      if (handler.isEventHandler) {
        this.fayeClient.subscribe(pattern, async (message: ReadPacket) => {
          await handler(message.data);
        });
      }
    });
  }

  /**
   *
   */
  public bindHandlers() {
    /**
     * messageHandlers is populated by the Framework (on the Server superclass).
     *
     * It's a map of `pattern` -> `handler` key/value pairs
     * `handler` is a function with an additional boolean property
     * indicating it's Nest type: event or message (request/response)
     */
    this.messageHandlers.forEach((handler, pattern) => {
      if (handler.isEventHandler) {
        this.fayeClient.subscribe(pattern, async (rawPacket: ReadPacket) => {
          const packet = this.parsePacket(rawPacket);
          const message = this.deserializer.deserialize(packet);
          await handler(message.data);
        });
      } else {
        this.fayeClient.subscribe(
          `${pattern}_ack`,
          this.getMessageHandler(pattern, handler),
        );
      }
    });
  }

  // simple: handles a response that is a plain value or object, but
  // does NOT handle a response stream RxJS stream
  public getMessageHandler(pattern: string, handler: Function): Function {
    return async (rawPacket: ReadPacket) => {
      const packet = this.parsePacket(rawPacket);
      const message = this.deserializer.deserialize(packet);
      const response = await handler(message.data);
      const writePacket = {
        err: undefined,
        response,
        isDisposed: true,
        id: (message as any).id,
      };
      this.fayeClient.publish(
        `${pattern}_res`,
        this.serializer.serialize(writePacket),
      );
    };
  }

  // better: handles streams as well
  public xgetMessageHandler(pattern: string, handler: Function): Function {
    return async (rawPacket: ReadPacket) => {
      const packet = this.parsePacket(rawPacket);
      const message = this.deserializer.deserialize(packet);

      const response$ = this.transformToObservable(
        await handler(message.data, {}),
      ) as Observable<any>;

      const publish = (response: any) => {
        Object.assign(response, { id: (message as any).id });
        const outgoingResponse = this.serializer.serialize(response);
        return this.fayeClient.publish(`${pattern}_res`, outgoingResponse);
      };

      // tslint:disable-next-line: no-unused-expression
      response$ && this.send(response$, publish);
    };
  }

  public parsePacket(content) {
    try {
      return JSON.parse(content);
    } catch (e) {
      return content;
    }
  }

  // error handling for faye server
  public handleError(stream: any) {
    stream.on(ERROR_EVENT, (err: any) => {
      this.logger.error('Faye Server offline!');
      this.close();
    });
  }
}
