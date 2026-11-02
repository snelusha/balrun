import ballerina/udp;

service class EchoService {
    *udp:Service;

    remote function onBytes(readonly & byte[] data) returns byte[] {
        return data;
    }
}

listener udp:Listener server = new (19605);

function init() returns error? {
    check server.attach(new EchoService());
}
