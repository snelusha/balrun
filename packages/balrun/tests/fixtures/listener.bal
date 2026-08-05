import ballerina/io;

class TestListener {
    public function attach(service object {} svc, () attachPoint = ()) returns () {
        _ = svc;
        _ = attachPoint;
        io:println("ready");
    }

    public function detach(service object {} svc) returns error? {
        _ = svc;
    }

    public function 'start() returns error? {
    }

    public function gracefulStop() returns error? {
        io:println("graceful stop");
    }

    public function immediateStop() returns error? {
        io:println("immediate stop");
    }
}

listener TestListener testListener = new ();

service on testListener {
}
