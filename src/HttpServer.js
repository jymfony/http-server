const EventDispatcher = Jymfony.Component.EventDispatcher.EventDispatcher;
const FunctionControllerResolver = Jymfony.Component.HttpFoundation.Controller.FunctionControllerResolver;
const BadRequestException = Jymfony.Component.HttpFoundation.Exception.BadRequestException;
const BadRequestHttpException = Jymfony.Component.HttpFoundation.Exception.BadRequestHttpException;
const HttpExceptionInterface = Jymfony.Component.HttpFoundation.Exception.HttpExceptionInterface;
const NotFoundHttpException = Jymfony.Component.HttpFoundation.Exception.NotFoundHttpException;
const RequestExceptionInterface = Jymfony.Component.HttpFoundation.Exception.RequestExceptionInterface;
const ContentType = Jymfony.Component.HttpFoundation.Header.ContentType;
const Request = Jymfony.Component.HttpFoundation.Request;
const Response = Jymfony.Component.HttpFoundation.Response;
const Event = Jymfony.Component.HttpServer.Event;
const EventListener = Jymfony.Component.HttpServer.EventListener;
const RequestParser = Jymfony.Component.HttpServer.RequestParser;
const NullLogger = Jymfony.Component.Logger.NullLogger;
const Router = Jymfony.Component.Routing.Router;
const FunctionLoader = Jymfony.Component.Routing.Loader.FunctionLoader;

const http = require('http');

/**
 * @memberOf Jymfony.Component.HttpServer
 */
class HttpServer {
    /**
     * Constructor.
     *
     * @param {Jymfony.Component.EventDispatcher.EventDispatcherInterface} dispatcher
     * @param {Jymfony.Component.HttpFoundation.Controller.ControllerResolverInterface} resolver
     */
    __construct(dispatcher, resolver) {
        /**
         * @type {Jymfony.Component.EventDispatcher.EventDispatcherInterface}
         *
         * @protected
         */
        this._dispatcher = dispatcher;

        /**
         * @type {Jymfony.Component.HttpFoundation.Controller.ControllerResolverInterface}
         *
         * @protected
         */
        this._resolver = resolver;

        /**
         * @type {http.Server}
         *
         * @protected
         */
        this._http = this._createServer();

        /**
         * @type {Jymfony.Component.Logger.LoggerInterface}
         *
         * @private
         */
        this._logger = new NullLogger();

        /**
         * @type {string|undefined}
         *
         * @protected
         */
        this._host = undefined;

        /**
         * @type {string|undefined}
         *
         * @protected
         */
        this._port = undefined;
    }

    /**
     * Creates a new Http server instance.
     *
     * @param {Jymfony.Component.Routing.RouteCollection} routes
     * @param {Jymfony.Component.Logger.LoggerInterface} logger
     *
     * @returns {Jymfony.Component.HttpServer.HttpServer}
     */
    static create(routes, logger = undefined) {
        const router = new Router(new FunctionLoader(), () => routes);
        const eventDispatcher = new EventDispatcher();
        eventDispatcher.addSubscriber(new EventListener.RouterListener(router));
        eventDispatcher.addSubscriber(new EventListener.ExceptionListener(
            (request) => {
                return new Response(JSON.stringify(request.attributes.get('exception')), Response.HTTP_OK, {
                    'content-type': 'application/json',
                });
            })
        );

        const server = new __self(eventDispatcher, new FunctionControllerResolver(logger));
        if (logger !== undefined) {
            server.setLogger(logger);
        }

        return server;
    }

    /**
     * Gets the current event dispatcher.
     *
     * @returns {Jymfony.Component.EventDispatcher.EventDispatcherInterface}
     */
    get eventDispatcher() {
        return this._dispatcher;
    }

    /**
     * Sets the logger for the current http server.
     *
     * @param {Jymfony.Component.Logger.LoggerInterface} logger
     */
    setLogger(logger) {
        this._logger = logger;
    }

    /**
     * Listen and handle connections.
     *
     * @returns {Promise<void>}
     */
    listen({ port = 80, host = '0.0.0.0', path = undefined } = {}) {
        return new Promise((resolve, reject) => {
            this._http.on('error', e => {
                this._http.removeAllListeners('close');
                this._http.close();

                reject(e);
            });

            this._http.on('close', () => {
                this._host = undefined;
                this._port = undefined;

                resolve();
            });

            this._http.on('upgrade', (request, socket) => {
                socket.writeHead = (statusCode, reason = undefined, obj = undefined) => {
                    if (! isString(reason)) {
                        obj = reason;
                        reason = Response.statusTexts[statusCode];
                    }

                    statusCode |= 0;
                    if (100 > statusCode || 999 < statusCode) {
                        throw new RangeError(`Invalid status code: ${statusCode}`);
                    }

                    socket.write('HTTP/1.1 ' + statusCode.toString() + ' ' + reason + '\r\n');
                    for (const [ key, value ] of __jymfony.getEntries(obj || {})) {
                        if (! isArray(value)) {
                            socket.write(key + ': ' + value + '\r\n');
                        } else {
                            value.forEach(v => socket.write(key + ': ' + v + '\r\n'));
                        }
                    }

                    socket.write('\r\n');
                };

                return this._incomingRequest(request, socket);
            });

            if (!! path) {
                this._http.listen({ path });
            } else {
                this._host = host;
                this._port = port;
                this._http.listen({ host, port });
            }

            this._logger.debug('Http server listening on '+(path || host + ':' + port));
        });
    }

    async close() {
        if (! this._http.listening) {
            return;
        }

        await this._dispatcher.dispatch(Event.HttpServerEvents.SERVER_TERMINATE);
        this._http.close();
    }

    /**
     * Creates a new http server.
     *
     * @returns {http.Server}
     *
     * @protected
     */
    _createServer() {
        return new http.Server(this._incomingRequest.bind(this));
    }

    /**
     * Handles an incoming request from the http server.
     *
     * @param {IncomingMessage} req
     * @param {ServerResponse} res
     *
     * @returns {Promise<void>}
     *
     * @private
     */
    async _incomingRequest(req, res) {
        try {
            await this._handleRequest(req, res);
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.write('Unknown error while handling your request.\r\n');
            res.end();

            this._logger.error('Error while processing request: ' + e.message, {
                exception: e,
                request: req,
            });
        }
    }

    /**
     * Converts an IncomingMessage to an HttpFoundation request
     * and sends it to the Kernel.
     *
     * @param {IncomingMessage} req
     * @param {ServerResponse} res
     *
     * @returns {Promise<void>}
     *
     * @protected
     */
    async _handleRequest(req, res) {
        const contentType = new ContentType(req.headers['content-type'] || 'application/x-www-form-urlencoded');
        let requestParams, content;

        try {
            [ requestParams, content ] = await this._parseRequestContent(req, req.headers, contentType);
        } catch (e) {
            if (e instanceof BadRequestException) {
                res.writeHead(400, {'Content-Type': 'text/plain'});
            } else {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                this._logger.error('Error while parsing request content: '+e.message, {
                    exception: e,
                    request: req,
                });
            }

            res.end();
            return;
        }

        const request = new Request(req.url, requestParams, {}, req.headers, {
            'REQUEST_METHOD': req.method,
            'REMOTE_ADDR': req.connection.remoteAddress,
            'SCHEME': this._getScheme(req.headers),
            'SERVER_NAME': this._host,
            'SERVER_PORT': this._port,
            'SERVER_PROTOCOL': 'HTTP/'+req.httpVersion,
        }, content);

        let response = await this.handle(request);
        if (response instanceof Promise) {
            response = await response;
        }

        await response.prepare(request);
        await response.sendResponse(req, res);

        const event = new Event.PostResponseEvent(this, request, response);
        await this._dispatcher.dispatch(Event.HttpServerEvents.TERMINATE, event);
    }

    /**
     * Handles a Request to convert it to a Response.
     *
     * When catchExceptions is true, catches all exceptions
     * and do its best to convert them to a Response instance.
     *
     * @param {Jymfony.Component.HttpFoundation.Request} request A Request instance
     * @param {boolean} [catchExceptions = true] Whether to catch exceptions or not
     *
     * @returns {Promise<Jymfony.Component.HttpFoundation.Response>} A Response instance
     *
     * @throws {Exception} When an Exception occurs during processing
     */
    async handle(request, catchExceptions = true) {
        let response;

        try {
            response = await this._handleRaw(request);
        } catch (e) {
            if (e instanceof RequestExceptionInterface) {
                e = new BadRequestHttpException(e.message, e);
            }

            if (false === catchExceptions) {
                throw e;
            }

            response = await this._handleException(e, request);
        }

        return response;
    }

    /**
     * Get the public scheme for this server (http/https)
     *
     * @returns {string}
     */
    get scheme() {
        return 'http';
    }

    /**
     * Parse request content.
     *
     * @param {stream.Duplex} stream
     * @param {Object} headers
     * @param {Jymfony.Component.HttpFoundation.Header.ContentType} contentType
     *
     * @returns {Promise<Array>} An array composed by the request params object
     *     and the content as Buffer
     *
     * @protected
     */
    async _parseRequestContent(stream, headers, contentType) {
        if (headers['sec-websocket-key']) {
            return [ {}, undefined ];
        }

        const contentLength = ~~headers['content-length'];
        let parser;
        if ('application/x-www-form-urlencoded' === contentType.essence) {
            parser = new RequestParser.UrlEncodedParser(stream, contentLength);
        } else if ('application/json' === contentType.essence) {
            parser = new RequestParser.JsonEncodedParser(stream, contentLength, contentType.get('charset', 'utf-8'));
        } else if ('multipart' === contentType.type) {
            parser = new RequestParser.MultipartParser(stream, contentType, contentLength);
        } else {
            parser = new RequestParser.OctetStreamParser(stream, contentLength);
        }

        const params = await parser.parse();

        return [ params, parser.buffer ];
    }

    /**
     * Dispatches request through the event dispatcher to obtain a valid response.
     *
     * @param {Jymfony.Component.HttpFoundation.Request} request
     *
     * @returns {Promise<Jymfony.Component.HttpFoundation.Response>}
     *
     * @protected
     */
    async _handleRaw(request) {
        let event = new Event.GetResponseEvent(this, request);
        await this._dispatcher.dispatch(Event.HttpServerEvents.REQUEST, event);

        if (event.hasResponse()) {
            return await this._filterResponse(event.response, request);
        }

        let controller = this._resolver.getController(request);
        if (false === controller) {
            throw new NotFoundHttpException(__jymfony.sprintf('Unable to find the controller for path "%s". The route is wrongly configured.', request.pathInfo));
        }

        event = new Event.FilterControllerEvent(this, controller, request);
        await this._dispatcher.dispatch(Event.HttpServerEvents.CONTROLLER, event);
        controller = event.controller;

        let response = await controller(request);
        if (! (response instanceof Response)) {
            const event = new Event.GetResponseForControllerResultEvent(this, request, response);
            await this._dispatcher.dispatch(Event.HttpServerEvents.VIEW, event);

            if (event.hasResponse()) {
                response = event.response;
            } else {
                let msg = 'The controller must return a response.';

                // The user may have forgotten to return something
                if (undefined === response) {
                    msg += ' Did you forget to add a return statement somewhere in your controller?';
                }

                throw new LogicException(msg);
            }
        }

        return await this._filterResponse(response, request);
    }

    /**
     * Handles an exception by trying to convert it to a Response.
     *
     * @param {Error} e An Error instance
     * @param {Jymfony.Component.HttpFoundation.Request} request A Request instance
     *
     * @returns {Promise<Jymfony.Component.HttpFoundation.Response>}
     *
     * @protected
     */
    async _handleException(e, request) {
        const event = new Event.GetResponseForExceptionEvent(this, request, e);
        await this._dispatcher.dispatch(Event.HttpServerEvents.EXCEPTION, event);

        // A listener might have replaced the exception
        e = event.exception;
        if (! event.hasResponse()) {
            await this._dispatcher.dispatch(Event.HttpServerEvents.FINISH_REQUEST, new Event.FinishRequestEvent(this, request));

            throw e;
        }

        const response = event.response;

        // The developer asked for a specific status code
        if (! event.isAllowingCustomResponseCode && ! response.isClientError && ! response.isServerError && ! response.isRedirect()) {
            // Ensure that we actually have an error response
            if (e instanceof HttpExceptionInterface) {
                // Keep the HTTP status code and headers
                response.setStatusCode(e.statusCode);
                response.headers.add(e.headers);
            } else {
                response.setStatusCode(500);
            }
        }

        try {
            return await this._filterResponse(response, request);
        } catch (e) {
            return response;
        }
    }

    /**
     * Gets the request scheme.
     *
     * @param {Object} headers
     *
     * @returns {string}
     *
     * @protected
     */
    _getScheme(headers) {
        if (headers['sec-websocket-key']) {
            return 'ws';
        }

        return 'http';
    }

    /**
     * Filters a response object.
     *
     * @param {Jymfony.Component.HttpFoundation.Response} response
     * @param {Jymfony.Component.HttpFoundation.Request} request
     *
     * @returns {Promise<Jymfony.Component.HttpFoundation.Response>}
     *
     * @private
     */
    async _filterResponse(response, request) {
        const event = new Event.FilterResponseEvent(this, request, response);
        await this._dispatcher.dispatch(Event.HttpServerEvents.RESPONSE, event);
        await this._dispatcher.dispatch(Event.HttpServerEvents.FINISH_REQUEST, new Event.FinishRequestEvent(this, request));

        return event.response;
    }
}

module.exports = HttpServer;
