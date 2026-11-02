import ballerina/io;
import ballerina/udp;

service class EchoService {
    *udp:Service;

    remote function onBytes(readonly & byte[] data) returns byte[] {
        return data;
    }
}

public function main() returns error? {
    udp:Listener server = check new (19601);
    check server.attach(new EchoService());
    check server.'start();

    udp:Client c = check new ({timeout: 5});
    check c->sendDatagram({remoteHost: "127.0.0.1", remotePort: 19601, data: "hello".toBytes()});
    readonly & udp:Datagram echoed = check c->receiveDatagram();
    io:println(check string:fromBytes(echoed.data), " ", echoed.remoteHost, ":", echoed.remotePort); // @output hello 127.0.0.1:19601
    check c->close();
    udp:Error? afterClose = c->sendDatagram({remoteHost: "127.0.0.1", remotePort: 19601, data: []});
    io:println(afterClose is udp:Error); // @output true
    udp:Error? closeTwice = c->close();
    io:println(closeTwice is ()); // @output true

    udp:ConnectClient cc = check new ("localhost", 19601, {timeout: 5});
    check cc->writeBytes("world".toBytes());
    readonly & byte[] reply = check cc->readBytes();
    io:println(check string:fromBytes(reply)); // @output world
    check cc->close();
    udp:Error? writeAfterClose = cc->writeBytes("x".toBytes());
    io:println(writeAfterClose is udp:Error); // @output true

    check server.gracefulStop();
}
