import ballerina/io;
import ballerina/udp;

service class EchoService {
    *udp:Service;

    remote function onBytes(readonly & byte[] data) returns byte[] {
        return data;
    }
}

public function main() returns error? {
    udp:Listener server = check new (19608);
    check server.attach(new EchoService());
    check server.'start();

    udp:ConnectClient cc = check new ("localhost", 19608, {timeout: 5});
    check cc->writeBytes("loop".toBytes());
    readonly & byte[] reply = check cc->readBytes();
    io:println(check string:fromBytes(reply)); // @output loop
    check cc->close();
    check server.gracefulStop();
}
