import ballerina/io;
import ballerina/udp;

service class EchoService {
    *udp:Service;

    remote function onBytes(readonly & byte[] data) returns byte[] {
        return data;
    }
}

public function main() returns error? {
    udp:Listener server = check new (19606);
    check server.attach(new EchoService());
    check server.'start();
    udp:Client _ = check new ();
    io:println("ran"); // @output ran
    panic error("exit without cleanup");
}
