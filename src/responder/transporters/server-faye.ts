import { Server, CustomTransportStrategy } from '@nestjs/microservices';

import { FayeClient } from '../../external/faye-client.interface';
import { ERROR_EVENT } from '../../constants';
import { FayeOptions } from '../../interfaces/faye-options.interface';

import * as faye from 'faye';

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

  // kick things off
  public start(callback) {
    // register for error events
    this.handleError(this.fayeClient);

    // traverse all registered patterns and bind handlers to them
    this.bindHandlers();

    // call any user-supplied callback from `app.listen()` call
    callback();
  }

  public bindHandlers() {
    /**
     * messageHandlers is populated by the Framework (on the Server superclass).
     *
     * It's a map of pattern -> handler key/value pairs
     * handler is a function with an additional boolean property
     * indicating it's Nest type: event or message (request/response)
     */
    this.messageHandlers.forEach((handler, pattern) => {
      if (handler.isEventHandler) {
        this.fayeClient.subscribe(pattern, async (message: any) => {
          await handler(message.data, {});
        });
      }
    });
  }

  // error handling for faye server
  public handleError(stream: any) {
    stream.on(ERROR_EVENT, (err: any) => {
      this.logger.error('Faye Server offline!');
      this.close();
    });
  }
}
