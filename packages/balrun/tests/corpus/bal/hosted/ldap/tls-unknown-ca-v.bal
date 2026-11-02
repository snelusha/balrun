import ballerina/io;
import ballerina/ldap;

public function main() {
    ldap:Client|ldap:Error c = new ({hostName: "localhost", port: 19624, domainName: "cn=admin", password: "pw", clientSecureSocket: {}});
    io:println(c is ldap:Error && c.message().includes("x509")); // @output true
}
