declare namespace Jymfony.Component.HttpServer.Controller.ArgumentResolvers {
    import RequestInterface = Jymfony.Contracts.HttpFoundation.RequestInterface;

    /**
     * Yields the same instance as the request object passed along.
     *
     * @final
     */
    export class SessionValueResolver extends implementationOf(ArgumentValueResolverInterface) {
        /**
         * @inheritdoc
         */
        supports(request: RequestInterface, argument: ReflectionParameter): boolean;

        /**
         * @inheritdoc
         */
        resolve(request: RequestInterface, argument: ReflectionParameter): Iterator<any>;
    }
}
