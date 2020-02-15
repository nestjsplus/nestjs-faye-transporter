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

import * as util from 'util';

import { Observable } from 'rxjs';

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
    callback();
  }

  //  public bindHandlers() {
  //    /**
  //     * messageHandlers is populated by the Framework on the superclass
  //     * It's a map of pattern -> handler key/value pairs
  //     * handler is a function with an additional boolean property
  //     * indicating it's Nest type: event or message (request/response)
  //     */
  //    this.messageHandlers.forEach((handler, pattern) => {
  //      if (handler.isEventHandler) {
  //        this.fayeClient.subscribe(
  //          pattern,
  //          this.getSubscribeFunction(pattern, handler),
  //        );
  //      }
  //    });
  //  }

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
          await handler(JSON.parse(message).data, {});
        });
      }
    });
  }

  /**
   * Build our faye subscribe function.  These have signature
   * (message: any) => {
   *    // handle message
   * }
   *
   * Our factory
   */
  public getSubscribeFunction(pattern: string, handler: Function): Function {
    return async (message: any) => {
      // rehydrate JSON
      const rawPacket = this.parseMessage(message);

      // deserialize object - mainly to handle changing the shape of
      // inbound objects from non-Nest producers
      const packet = this.deserializer.deserialize(rawPacket, {});

      // for now, we're just handling events
      // return this.handleEvent(pattern, packet, {} as FayeContext);
      // const handler = this.getHandlerByPattern(pattern);
      await handler(packet.data, {});
    };
  }

  /**
   * Responsible for calling the Nest handler method registered to this pattern,
   * taking into account whether the pattern type is request/response or event.
   *
   * Request/Response case
   * =====================
   *
   * For example, controller `AppController` may have the following construct,
   * declaring `getCustomers()` to be the handler to be called when a message on
   * the subject `/get-customers_ack` is received:
   *
   *    @MessagePattern('/get-customers')
   *    getCustomers(data) {
   *      return this.customers;
   *    }
   *
   * In this case ( `(message as IncomingRequest).id` *is defined* below ) we
   * take these  steps:
   * 1. lookup the handler by pattern
   * 2. wrap a call to the handler in an observable
   * 3. build a Faye `publish()` function to publish the observable containing
   *    the response
   * 4. publish the observable response
   *
   * Event case
   * ==========
   *
   * For example, controller `AppController` may have the following construct,
   * declaring `getCustomers()` to be the handler to be called when a message on
   * the subject `/get-customers_ack` is received:
   *
   *     @EventPattern('/add-customer')
   *     addCustomer(customer: Customer) {
   *        customerList.push(...)
   *     }
   *
   * In this case ( `(message as IncomingRequest).id` *is NOT defined* below )
   * we simply invoke the generic event handler code. **There is no further
   * interactin with the broker/comm layer** since there is no response.
   * This case is much simpler so the event code is provided by the framework
   * and works generically across all transports.
   */
  public async handleMessage(
    channel: any,
    buffer: string,
    pub: FayeClient,
  ): Promise<any> {
    const fayeCtx = new FayeContext([channel]);
    const rawPacket = this.parseMessage(buffer);
    const message = this.deserializer.deserialize(rawPacket, {
      channel,
    });
    if (isUndefined((message as IncomingRequest).id)) {
      return this.handleEvent(channel, message, fayeCtx);
    }
    const pattern = message.pattern.replace(/_ack$/, '');

    // build a publisher: build a function of the form
    // client.publish('subject', () => { /** handler */});
    const publish = this.buildPublisher(
      pub,
      pattern,
      (message as IncomingRequest).id,
    );

    // get the actual pattern handler (e.g., `getCustomer()`)
    const handler = this.getHandlerByPattern(pattern);
    // handle case of missing publisher
    if (!handler) {
      const status = 'error';
      const noHandlerPacket = {
        id: (message as IncomingRequest).id,
        status,
        err: NO_MESSAGE_HANDLER,
      };
      return publish(noHandlerPacket);
    }

    // wrap the handler call in an observable
    const response$ = this.transformToObservable(
      await handler(message.data, fayeCtx),
    ) as Observable<any>;

    // subscribe to the observable (thus invoking the handler and
    // returning the response stream). `send()` is inherited from
    // the super class, and handles the machinery of returning the
    // response stream.
    // tslint:disable-next-line: no-unused-expression
    response$ && this.send(response$, publish);
  }

  // returns a "publisher": a properly configured Faye `client.publish()` call
  public buildPublisher(client: FayeClient, pattern: any, id: string): any {
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
