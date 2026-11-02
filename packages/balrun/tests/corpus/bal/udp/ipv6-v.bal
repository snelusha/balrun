// @requires ipv6
import ballerina/io;
import ballerina/udp;

service class EchoService {
    *udp:Service;

    remote function onBytes(readonly & byte[] data) returns byte[] {
        return data;
    }
}

public function main() returns error? {
    udp:Listener server = check new (19602);
    check server.attach(new EchoService());
    check server.'start();

    udp:ConnectClient cc = check new ("::1", 19602, {timeout: 5});
    check cc->writeBytes("six".toBytes());
    readonly & byte[] reply = check cc->readBytes();
    io:println(check string:fromBytes(reply)); // @output six
    check cc->close();
    check server.immediateStop();
}
