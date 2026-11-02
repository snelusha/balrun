import ballerina/io;
import ballerina/ldap;

public function main() returns error? {
    ldap:Client c = check new ({hostName: "localhost", port: 19621, domainName: "cn=admin", password: "pw", clientSecureSocket: {cert: "ca.pem"}});
    boolean connected = check c->isConnected();
    io:println(connected); // @output true
    check c->close();
}
