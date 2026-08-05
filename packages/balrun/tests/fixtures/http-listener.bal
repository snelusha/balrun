import ballerina/http;

function response(string payload) returns http:Response {
    http:Response result = new;
    result.setTextPayload(payload);
    return result;
}

service / on new http:Listener(6969, {host: "127.0.0.1"}) {
    resource function get ping() returns http:Response {
        http:Response result = response("pong");
        result.addHeader("X-Reply", "one");
        result.addHeader("X-Reply", "two");
        return result;
    }

    resource function get inspect(http:Request request) returns http:Response|error {
        string header = check request.getHeader("X-Test");
        return response(string `${request.rawPath}|${header}`);
    }

    resource function post echo(http:Request request) returns http:Response|error {
        return response(check request.getTextPayload());
    }

    resource function put echo(http:Request request) returns http:Response|error {
        return response(check request.getTextPayload());
    }

    resource function patch echo(http:Request request) returns http:Response|error {
        return response(check request.getTextPayload());
    }

    resource function delete echo(http:Request request) returns http:Response|error {
        return response(check request.getTextPayload());
    }

    resource function head echo() returns http:Response {
        return response("head");
    }

    resource function options echo() returns http:Response {
        return response("options");
    }
}
