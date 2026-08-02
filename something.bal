import ballerina/io;

class TaggedListener {
    string tag;

    function init(string tag) {
        self.tag = tag;
    }

    public function attach(service object {} svc, () attachPoint = ()) returns () {
        _ = svc;
        _ = attachPoint;
        io:println("attached: ", self.tag);
    }

    public function detach(service object {} svc) returns error? {
        _ = svc;
    }

    public function 'start() returns error? {
    }

    public function gracefulStop() returns error? {
        io:println("amila");
    }

    public function immediateStop() returns error? {
        io:println("yuvindu");
    }
}

function makeListener(string tag) returns TaggedListener {
    return new TaggedListener(tag);
}

listener TaggedListener l = new ("var");

service on l, new TaggedListener("inline"), makeListener("call") {
    // @output attached: var
    // @output attached: inline
    // @output attached: call
}

public function main() {
}
