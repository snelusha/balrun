import ballerina/io;
import ballerina/udp;

service class EchoService {
    *udp:Service;

    remote function onBytes(readonly & byte[] data) returns byte[] {
        return data;
    }
}

public function main() returns error? {
    udp:Listener first = check new (19604);
    check first.attach(new EchoService());
    check first.'start();

    udp:Listener second = check new (19604);
    check second.attach(new EchoService());
    error? started = second.'start();
    io:println(started is error && started.message().includes("address already in use")); // @output true
    check first.gracefulStop();
}
